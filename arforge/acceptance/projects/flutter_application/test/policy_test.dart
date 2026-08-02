import 'package:arforge_acceptance/policy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('normalizes valid title', () {
    expect(normalizeTitle('  project depth  '), 'project depth');
  });
}
