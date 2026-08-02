import 'package:arforge_acceptance/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders the application contract', (tester) async {
    await tester.pumpWidget(const AcceptanceApp());
    expect(find.text('Arforge Flutter project depth'), findsOneWidget);
    expect(find.byKey(const Key('status')), findsOneWidget);
  });
}
