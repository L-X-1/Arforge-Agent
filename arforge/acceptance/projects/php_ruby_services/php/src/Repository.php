<?php
declare(strict_types=1);

final class Repository
{
    /** @var list<array{id:int,title:string,status:string}> */
    private array $items = [];

    /** @return array{id:int,title:string,status:string} */
    public function create(string $title): array
    {
        $normalized = trim($title);
        if ($normalized === '') {
            throw new InvalidArgumentException('title is required');
        }
        $item = [
            'id' => count($this->items) + 1,
            'title' => $normalized,
            'status' => 'open',
        ];
        $this->items[] = $item;
        return $item;
    }

    /** @return list<array{id:int,title:string,status:string}> */
    public function all(): array
    {
        return $this->items;
    }
}
