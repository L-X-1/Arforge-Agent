# frozen_string_literal: true

class Repository
  def initialize
    @items = []
  end

  def create(title)
    normalized = title.to_s.strip
    raise ArgumentError, "title is required" if normalized.empty?

    item = { id: @items.length + 1, title: normalized, status: "open" }
    @items << item
    item
  end

  def all
    @items.map(&:dup)
  end
end
