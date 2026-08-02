namespace Arforge.Acceptance;

public sealed record WorkItem(int Id, string Title, string Status);

public static class Policy
{
    public static string NormalizeTitle(string? title)
    {
        var normalized = title?.Trim() ?? string.Empty;
        if (normalized.Length == 0)
        {
            throw new ArgumentException("title is required", nameof(title));
        }
        return normalized;
    }
}
