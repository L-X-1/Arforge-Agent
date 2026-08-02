String normalizeTitle(String value) {
  final normalized = value.trim();
  if (normalized.isEmpty) {
    throw ArgumentError('title is required');
  }
  return normalized;
}
