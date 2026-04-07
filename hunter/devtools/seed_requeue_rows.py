import argparse

from hunter.db import get_connection, init_db  # type: ignore


def main() -> int:
    p = argparse.ArgumentParser(
        description="Seed a couple of failed enrichment rows to manually test requeue-by-error-code."
    )
    p.add_argument("--source", default="linkedin")
    args = p.parse_args()

    init_db()
    conn = get_connection()
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO jobs (title, job_url, source, enrichment_status, last_enrichment_error) VALUES (?,?,?,?,?)",
        (
            "SEED auth expired",
            "http://seed/auth-expired",
            args.source,
            "failed",
            "auth_expired: seed",
        ),
    )
    cur.execute(
        "INSERT INTO jobs (title, job_url, source, enrichment_status, last_enrichment_error) VALUES (?,?,?,?,?)",
        (
            "SEED rate limited",
            "http://seed/rate-limited",
            args.source,
            "failed",
            "rate_limited: seed",
        ),
    )

    conn.commit()
    conn.close()
    print("Seeded 2 failed rows (auth_expired + rate_limited).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
