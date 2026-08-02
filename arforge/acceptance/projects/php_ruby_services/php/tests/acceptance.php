<?php
declare(strict_types=1);

require __DIR__ . '/../src/Repository.php';

$suite = $argv[1] ?? 'all';
if ($suite === 'unit' || $suite === 'all') {
    $repository = new Repository();
    assert($repository->create('  depth  ')['title'] === 'depth');
}
if ($suite === 'integration' || $suite === 'all') {
    $repository = new Repository();
    $repository->create('first');
    $repository->create('second');
    assert(array_column($repository->all(), 'title') === ['first', 'second']);
}
if ($suite === 'negative' || $suite === 'all') {
    $repository = new Repository();
    try {
        $repository->create('   ');
        throw new RuntimeException('blank title was accepted');
    } catch (InvalidArgumentException) {
        assert($repository->all() === []);
    }
}
echo "PASS:$suite\n";
