namespace Arforge.Acceptance;

public sealed class Repository
{
    private readonly List<WorkItem> items = [];

    public WorkItem Create(string? title)
    {
        var item = new WorkItem(
            items.Count + 1,
            Policy.NormalizeTitle(title),
            "open"
        );
        items.Add(item);
        return item;
    }

    public IReadOnlyList<WorkItem> List() => items.AsReadOnly();
}
