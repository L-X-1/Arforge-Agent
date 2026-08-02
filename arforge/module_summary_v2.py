"""Module summary facade."""

from arforge import code_summarizer as _code_summarizer


def summarize_code_file(file_path: str) -> str:
    return _code_summarizer.summarize_code_file(file_path)


def generate_all_module_summaries():
    return _code_summarizer.generate_all_module_summaries()


def list_module_summaries(limit: int = 50):
    return _code_summarizer.list_module_summaries(limit)


def search_module_summaries(keyword: str, limit: int = 20):
    return _code_summarizer.search_module_summaries(keyword, limit)
