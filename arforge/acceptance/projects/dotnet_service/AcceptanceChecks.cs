namespace Arforge.Acceptance;

public static class AcceptanceChecks
{
    public static void Unit()
    {
        if (Policy.NormalizeTitle("  depth  ") != "depth")
        {
            throw new InvalidOperationException("unit check failed");
        }
    }

    public static void Integration()
    {
        var repository = new Repository();
        repository.Create("first");
        repository.Create("second");
        if (repository.List().Select(item => item.Title).SequenceEqual(["first", "second"]) is false)
        {
            throw new InvalidOperationException("integration check failed");
        }
    }

    public static void Negative()
    {
        var repository = new Repository();
        try
        {
            repository.Create("   ");
            throw new InvalidOperationException("blank title was accepted");
        }
        catch (ArgumentException)
        {
            if (repository.List().Count != 0)
            {
                throw new InvalidOperationException("invalid input mutated state");
            }
        }
    }
}
