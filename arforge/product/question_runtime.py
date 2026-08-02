"""Structured user-question runtime shared by terminal and machine clients."""

from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator

from arforge.security_guard import sanitize_for_storage


MAX_QUESTIONS = 4
MAX_OPTIONS = 4
MAX_QUESTION_CHARS = 500
MAX_HEADER_CHARS = 12
MAX_LABEL_CHARS = 80
MAX_DESCRIPTION_CHARS = 500
MAX_PREVIEW_CHARS = 20_000
MAX_ANSWER_CHARS = 2_000


class QuestionRuntimeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


QuestionHandler = Callable[[list[dict[str, Any]], dict[str, Any]], dict[str, Any]]
_HANDLER: ContextVar[QuestionHandler | None] = ContextVar("arforge_question_handler", default=None)


def _text(
    value: Any,
    *,
    field: str,
    maximum: int,
    required: bool = True,
) -> str:
    if not isinstance(value, str):
        raise QuestionRuntimeError("INVALID_QUESTION", f"{field} must be a string")
    cleaned = str(sanitize_for_storage(value)).strip()
    if required and not cleaned:
        raise QuestionRuntimeError("INVALID_QUESTION", f"{field} is required")
    if len(cleaned) > maximum:
        raise QuestionRuntimeError(
            "INVALID_QUESTION",
            f"{field} must be at most {maximum} characters",
        )
    return cleaned


def validate_questions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_QUESTIONS:
        raise QuestionRuntimeError(
            "INVALID_QUESTION",
            f"questions must contain between 1 and {MAX_QUESTIONS} items",
        )
    normalized: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise QuestionRuntimeError("INVALID_QUESTION", f"questions[{index}] must be an object")
        unexpected = set(raw) - {"question", "header", "options", "multi_select"}
        if unexpected:
            raise QuestionRuntimeError(
                "INVALID_QUESTION",
                f"questions[{index}] has unexpected fields: {', '.join(sorted(unexpected))}",
            )
        question = _text(
            raw.get("question"),
            field=f"questions[{index}].question",
            maximum=MAX_QUESTION_CHARS,
        )
        if question in seen_questions:
            raise QuestionRuntimeError("INVALID_QUESTION", "question texts must be unique")
        seen_questions.add(question)
        header = _text(
            raw.get("header"),
            field=f"questions[{index}].header",
            maximum=MAX_HEADER_CHARS,
        )
        options = raw.get("options")
        if not isinstance(options, list) or not 2 <= len(options) <= MAX_OPTIONS:
            raise QuestionRuntimeError(
                "INVALID_QUESTION",
                f"questions[{index}].options must contain between 2 and {MAX_OPTIONS} items",
            )
        normalized_options: list[dict[str, str]] = []
        labels: set[str] = set()
        for option_index, option in enumerate(options):
            if not isinstance(option, dict):
                raise QuestionRuntimeError(
                    "INVALID_QUESTION",
                    f"questions[{index}].options[{option_index}] must be an object",
                )
            unexpected_option = set(option) - {"label", "description", "preview"}
            if unexpected_option:
                raise QuestionRuntimeError(
                    "INVALID_QUESTION",
                    f"questions[{index}].options[{option_index}] has unexpected fields",
                )
            label = _text(
                option.get("label"),
                field=f"questions[{index}].options[{option_index}].label",
                maximum=MAX_LABEL_CHARS,
            )
            if label.casefold() == "other":
                raise QuestionRuntimeError(
                    "INVALID_QUESTION",
                    "the Other option is supplied by the client and must not be declared",
                )
            if label in labels:
                raise QuestionRuntimeError(
                    "INVALID_QUESTION",
                    "option labels must be unique within a question",
                )
            labels.add(label)
            normalized_option = {
                "label": label,
                "description": _text(
                    option.get("description"),
                    field=f"questions[{index}].options[{option_index}].description",
                    maximum=MAX_DESCRIPTION_CHARS,
                ),
            }
            if option.get("preview") is not None:
                normalized_option["preview"] = _text(
                    option.get("preview"),
                    field=f"questions[{index}].options[{option_index}].preview",
                    maximum=MAX_PREVIEW_CHARS,
                )
            normalized_options.append(normalized_option)
        multi_select = raw.get("multi_select", False)
        if not isinstance(multi_select, bool):
            raise QuestionRuntimeError(
                "INVALID_QUESTION",
                f"questions[{index}].multi_select must be a boolean",
            )
        if multi_select and any("preview" in option for option in normalized_options):
            raise QuestionRuntimeError(
                "INVALID_QUESTION",
                "previews are supported only for single-select questions",
            )
        normalized.append(
            {
                "question": question,
                "header": header,
                "options": normalized_options,
                "multi_select": multi_select,
            }
        )
    return normalized


def validate_answers(
    questions: list[dict[str, Any]],
    answers: Any,
    annotations: Any = None,
) -> dict[str, Any]:
    if not isinstance(answers, dict):
        raise QuestionRuntimeError("INVALID_ANSWER", "answers must be an object")
    expected = {item["question"] for item in questions}
    if set(answers) != expected:
        raise QuestionRuntimeError(
            "INVALID_ANSWER",
            "answers must contain exactly one entry for every question",
        )
    clean_answers: dict[str, str] = {}
    for question in questions:
        text = question["question"]
        answer = _text(
            answers.get(text),
            field=f"answer for {text}",
            maximum=MAX_ANSWER_CHARS,
        )
        labels = {option["label"] for option in question["options"]}
        if question["multi_select"]:
            selections = [part.strip() for part in answer.split(",") if part.strip()]
            if not selections:
                raise QuestionRuntimeError("INVALID_ANSWER", f"answer for {text} is empty")
            if len(selections) != len(set(selections)):
                raise QuestionRuntimeError("INVALID_ANSWER", f"answer for {text} contains duplicates")
            known = [selection for selection in selections if selection in labels]
            custom = [selection for selection in selections if selection not in labels]
            if len(custom) > 1 or (custom and len(selections) > 1):
                raise QuestionRuntimeError(
                    "INVALID_ANSWER",
                    f"answer for {text} must use listed options or one custom answer",
                )
            clean_answers[text] = ", ".join(known) if not custom else custom[0]
        else:
            clean_answers[text] = answer

    clean_annotations: dict[str, dict[str, str]] = {}
    if annotations is not None:
        if not isinstance(annotations, dict) or not set(annotations).issubset(expected):
            raise QuestionRuntimeError("INVALID_ANSWER", "annotations must be keyed by question text")
        for question_text, raw in annotations.items():
            if not isinstance(raw, dict) or set(raw) - {"preview", "notes"}:
                raise QuestionRuntimeError("INVALID_ANSWER", "annotation entries are invalid")
            item: dict[str, str] = {}
            if raw.get("preview") is not None:
                item["preview"] = _text(
                    raw["preview"],
                    field="annotation preview",
                    maximum=MAX_PREVIEW_CHARS,
                )
            if raw.get("notes") is not None:
                item["notes"] = _text(
                    raw["notes"],
                    field="annotation notes",
                    maximum=MAX_ANSWER_CHARS,
                )
            clean_annotations[question_text] = item
    result: dict[str, Any] = {"questions": questions, "answers": clean_answers}
    if clean_annotations:
        result["annotations"] = clean_annotations
    return result


@contextmanager
def question_handler(handler: QuestionHandler) -> Iterator[None]:
    token = _HANDLER.set(handler)
    try:
        yield
    finally:
        _HANDLER.reset(token)


def has_question_handler() -> bool:
    return _HANDLER.get() is not None


def request_questions(
    questions: Any,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized = validate_questions(questions)
    handler = _HANDLER.get()
    if handler is None:
        raise QuestionRuntimeError(
            "INTERACTION_UNAVAILABLE",
            "structured user questions require an interactive terminal or client",
        )
    response = handler(normalized, sanitize_for_storage(metadata or {}))
    if not isinstance(response, dict):
        raise QuestionRuntimeError("INVALID_ANSWER", "question handler returned an invalid response")
    return validate_answers(
        normalized,
        response.get("answers"),
        response.get("annotations"),
    )


def terminal_question_handler(
    questions: list[dict[str, Any]],
    _metadata: dict[str, Any],
) -> dict[str, Any]:
    if not sys.stdin.isatty():
        raise QuestionRuntimeError(
            "INTERACTION_UNAVAILABLE",
            "terminal input is not interactive",
        )
    answers: dict[str, str] = {}
    for question in questions:
        print(f"\n[{question['header']}] {question['question']}")
        for index, option in enumerate(question["options"], start=1):
            print(f"  {index}. {option['label']} - {option['description']}")
            if option.get("preview"):
                print(f"     Preview: {option['preview']}")
        print("  0. Other")
        suffix = " (comma-separated)" if question["multi_select"] else ""
        try:
            raw = input(f"Select{suffix}: ").strip()
        except (EOFError, KeyboardInterrupt):
            raise QuestionRuntimeError("QUESTION_REJECTED", "user declined to answer") from None
        if not raw:
            raise QuestionRuntimeError("QUESTION_REJECTED", "user declined to answer")
        values = [item.strip() for item in raw.split(",") if item.strip()]
        selected: list[str] = []
        custom = False
        for value in values:
            if value == "0":
                custom = True
                continue
            try:
                option = question["options"][int(value) - 1]
            except (ValueError, IndexError):
                raise QuestionRuntimeError("INVALID_ANSWER", f"invalid selection: {value}") from None
            selected.append(option["label"])
        if custom:
            if selected:
                raise QuestionRuntimeError(
                    "INVALID_ANSWER",
                    "Other cannot be combined with listed options",
                )
            try:
                custom_answer = input("Custom answer: ").strip()
            except (EOFError, KeyboardInterrupt):
                raise QuestionRuntimeError("QUESTION_REJECTED", "user declined to answer") from None
            selected = [custom_answer]
        if not question["multi_select"] and len(selected) != 1:
            raise QuestionRuntimeError("INVALID_ANSWER", "select exactly one option")
        answers[question["question"]] = ", ".join(selected)
    return {"answers": answers}


QUESTION_PARAM_SCHEMA = {
    "minItems": 1,
    "maxItems": MAX_QUESTIONS,
    "items": {
        "type": "object",
        "additionalProperties": False,
        "required": ["question", "header", "options"],
        "properties": {
            "question": {"type": "string", "maxLength": MAX_QUESTION_CHARS},
            "header": {"type": "string", "maxLength": MAX_HEADER_CHARS},
            "multi_select": {"type": "boolean", "default": False},
            "options": {
                "type": "array",
                "minItems": 2,
                "maxItems": MAX_OPTIONS,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["label", "description"],
                    "properties": {
                        "label": {"type": "string", "maxLength": MAX_LABEL_CHARS},
                        "description": {"type": "string", "maxLength": MAX_DESCRIPTION_CHARS},
                        "preview": {"type": "string", "maxLength": MAX_PREVIEW_CHARS},
                    },
                },
            },
        },
    },
}


def render_question_result(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False)
