# frozen_string_literal: true

require_relative "../lib/repository"

suite = ARGV.fetch(0, "all")
if ["unit", "all"].include?(suite)
  repository = Repository.new
  raise "unit" unless repository.create("  depth  ")[:title] == "depth"
end
if ["integration", "all"].include?(suite)
  repository = Repository.new
  repository.create("first")
  repository.create("second")
  raise "integration" unless repository.all.map { |item| item[:title] } == %w[first second]
end
if ["negative", "all"].include?(suite)
  repository = Repository.new
  begin
    repository.create("   ")
    raise "blank title was accepted"
  rescue ArgumentError
    raise "mutation" unless repository.all.empty?
  end
end
puts "PASS:#{suite}"
