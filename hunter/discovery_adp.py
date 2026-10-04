"""Read ADP Workforce Now's public career-center catalog and details."""

import json
from urllib.parse import parse_qsl, urlencode

from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def _field(row, group, name, value):
    return next(
        (
            f.get(value)
            for f in row.get("customFieldGroup", {}).get(group, [])
            if f.get("nameCode", {}).get("codeValue") == name
        ),
        None,
    )


def discover_adp(company, plan, *, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    base, query = plan["url"].split("?", 1)
    params = dict(parse_qsl(query))
    api = "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions"
    expected = None
    catalog_complete = False
    try:
        while True:
            start = len(seen) + 1
            data = json.loads(
                fetcher(
                    api
                    + "?"
                    + urlencode(
                        {
                            **params,
                            "locale": params.get("lang", "en_CA"),
                            "$top": 10,
                            "$skip": start,
                        }
                    )
                )
            )
            rows, meta = data.get("jobRequisitions"), data.get("meta", {})
            total = meta.get("totalNumber")
            if not isinstance(rows, list) or type(total) is not int or total < 0:
                raise ValueError("catalog_count_missing")
            if expected is not None and expected != total:
                raise ValueError("catalog_changed_during_scan")
            expected = total
            if total and meta.get("startSequence") != start:
                raise ValueError("pagination_repeated")
            if not rows and len(seen) < total:
                raise ValueError("pagination_incomplete")
            for row in rows:
                identity = _field(row, "stringFields", "ExternalJobID", "stringValue")
                if not isinstance(identity, str) or not identity.isdigit():
                    raise ValueError("invalid_job_id")
                if identity in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity)
                if (
                    _field(row, "indicatorFields", "InternalPostingFlag", "indicatorValue")
                    is not False
                ):
                    raise ValueError("posting_visibility_unverified")
                title = row["requisitionTitle"]
                if not matching_search_lane(title):
                    continue
                target = base + "?" + urlencode({**params, "jobId": identity})
                description, posted = None, None
                try:
                    detail = json.loads(fetcher(api + "/" + identity + "?" + urlencode(params)))
                    if (
                        not isinstance(row.get("itemID"), str)
                        or not row["itemID"].strip()
                        or detail.get("itemID") != row["itemID"]
                        or detail.get("requisitionTitle") != title
                        or _field(detail, "stringFields", "ExternalJobID", "stringValue")
                        != identity
                    ):
                        raise ValueError("detail_identity_mismatch")
                    if (
                        _field(detail, "indicatorFields", "InternalPostingFlag", "indicatorValue")
                        is not False
                    ):
                        raise ValueError("posting_visibility_unverified")
                    description = html_text(detail.get("requisitionDescription") or "")
                    if not description:
                        raise ValueError("description_not_found")
                    posted = _parse_date(detail.get("postDate"))
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=None,
                        url=target,
                        source="employer_adp",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            if len(seen) == total:
                break
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
