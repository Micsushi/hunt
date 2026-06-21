from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

ActorType = Literal["human", "agent", "system", "script"]
ProbeStatus = Literal["written", "run", "useful", "promoted", "stale", "archived"]


class LeaseKind(StrEnum):
    LANE = "lane"
    SESSION_MUTATION = "session_mutation"


class LeaseStatus(StrEnum):
    ACTIVE = "active"
    RELEASED = "released"
    EXPIRED = "expired"
    TRANSFERRED = "transferred"
    INTERRUPTED_BY_HUMAN = "interrupted_by_human"


class LaneStatus(StrEnum):
    ACTIVE = "active"
    FAILED = "failed"
    COMPLETED = "completed"


class SessionStatus(StrEnum):
    ACTIVE = "active"
    FAILED = "failed"
    REPLACED = "replaced"
    CLOSED = "closed"


@dataclass(frozen=True)
class Actor:
    type: ActorType
    id: str
    surface: str

    @property
    def is_human(self) -> bool:
        return self.type == "human"

    def as_event_actor(self) -> dict[str, str]:
        return {"type": self.type, "id": self.id, "surface": self.surface}


@dataclass
class LaneRecord:
    lane_id: str
    status: LaneStatus = LaneStatus.ACTIVE
    session_ids: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class SessionRecord:
    session_id: str
    lane_id: str
    parent_session_id: str | None = None
    status: SessionStatus = SessionStatus.ACTIVE
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class LeaseRecord:
    lease_id: str
    kind: LeaseKind
    actor: Actor
    lane_id: str | None = None
    session_id: str | None = None
    ttl_seconds: int = 60
    status: LeaseStatus = LeaseStatus.ACTIVE
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    heartbeat_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    released_at: datetime | None = None
    expired_at: datetime | None = None
    transferred_at: datetime | None = None
    interrupted_at: datetime | None = None
    transferred_to_agent_id: str | None = None
    interrupt_actor: Actor | None = None
    interrupt_reason: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def is_active_at(self, now: datetime) -> bool:
        return self.status == LeaseStatus.ACTIVE and not self.is_stale_at(now)

    def is_stale_at(self, now: datetime) -> bool:
        age_seconds = (now - self.heartbeat_at).total_seconds()
        return age_seconds >= self.ttl_seconds


class ActorPayload(BaseModel):
    type: ActorType = "system"
    id: str = ""
    surface: str = ""


class AgentCreate(BaseModel):
    agent_id: str | None = None
    component: str = "c3"
    actor: ActorPayload = Field(default_factory=ActorPayload)
    metadata: dict[str, Any] = Field(default_factory=dict)


class LaneCreate(BaseModel):
    lane_id: str | None = None
    component: str = "c3"
    agent_id: str = ""
    actor: ActorPayload = Field(default_factory=ActorPayload)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionCreate(BaseModel):
    session_id: str | None = None
    component: str = "c3"
    agent_id: str = ""
    lane_id: str = ""
    parent_session_id: str = ""
    actor: ActorPayload = Field(default_factory=ActorPayload)
    metadata: dict[str, Any] = Field(default_factory=dict)


class LedgerEventIn(BaseModel):
    event_id: str | None = None
    component: str = "c3"
    event_type: str
    actor: ActorPayload = Field(default_factory=ActorPayload)
    agent_id: str = ""
    lane_id: str = ""
    session_id: str = ""
    lease_id: str = ""
    command_id: str = ""
    trace_id: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


class LeaseClaimRequest(BaseModel):
    lease_type: Literal["lane", "session_mutation"] = "session_mutation"
    actor: ActorPayload = Field(default_factory=ActorPayload)
    agent_id: str = ""
    lane_id: str = ""
    session_id: str = ""
    ttl_seconds: int = 60
    metadata: dict[str, Any] = Field(default_factory=dict)


class LeaseActionRequest(BaseModel):
    actor: ActorPayload = Field(default_factory=ActorPayload)
    agent_id: str = ""
    target_actor: ActorPayload | None = None
    reason: str = ""


class ProbeFileCreate(BaseModel):
    component: str = "c3"
    agent_id: str = ""
    lane_id: str = ""
    session_id: str = ""
    command_id: str = ""
    failure_event_id: str = ""
    filename: str
    content: str
    trusted: bool = False
    status: ProbeStatus = "written"
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProbeStatusUpdate(BaseModel):
    component: str = "c3"
    agent_id: str = ""
    lane_id: str = ""
    session_id: str = ""
    command_id: str = ""
    failure_event_id: str = ""
    status: ProbeStatus
    metadata: dict[str, Any] = Field(default_factory=dict)
