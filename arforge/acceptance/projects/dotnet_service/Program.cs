using Arforge.Acceptance;

var suite = args.FirstOrDefault() ?? "all";
if (suite is "unit" or "all")
{
    AcceptanceChecks.Unit();
}
if (suite is "integration" or "all")
{
    AcceptanceChecks.Integration();
}
if (suite is "negative" or "all")
{
    AcceptanceChecks.Negative();
}
Console.WriteLine($"PASS:{suite}");
