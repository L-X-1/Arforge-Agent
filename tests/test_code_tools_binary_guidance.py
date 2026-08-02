from __future__ import annotations

import pytest


def test_code_read_rejects_binary_office_files_with_actionable_guidance():
    from arforge.tools.code_tools import code_read

    with pytest.raises(ValueError, match="read_office_document"):
        code_read("report.docx")
