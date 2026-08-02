"""Primary user-visible message tool with local attachment metadata."""

from __future__ import annotations

import json

from arforge.tool_registry import ParamSchema, register_tool
from arforge.user_message_runtime import publish_user_message


@register_tool(
    "deliver_user_message",
    "Deliver the primary message the user should see. Use status proactive only for an "
    "unsolicited completion, blocker, or important background update. Optional attachments "
    "must be existing files in an authorized workspace and are never uploaded.",
    params=[
        ParamSchema("message", "string", "concise user-visible Markdown message"),
        ParamSchema(
            "status",
            "string",
            "normal for a direct reply; proactive for an unsolicited important update",
            json_schema={"enum": ["normal", "proactive"]},
        ),
        ParamSchema(
            "attachments",
            "array",
            "optional local file paths to present with the message",
            required=False,
            default=[],
            json_schema={"items": {"type": "string"}, "maxItems": 8},
        ),
    ],
    risk="medium",
    category="read",
    source=__name__,
    always_load=True,
    search_hint="primary visible user message proactive update local attachments files",
)
def deliver_user_message(
    message: str,
    status: str,
    attachments: list[str] | None = None,
) -> str:
    delivery = publish_user_message(
        message,
        status=status,
        attachments=attachments,
    )
    return json.dumps(
        {
            "delivered": True,
            "status": delivery["status"],
            "attachment_count": delivery["attachment_count"],
            "sent_at": delivery["sent_at"],
            "local_only": True,
        },
        ensure_ascii=False,
    )
