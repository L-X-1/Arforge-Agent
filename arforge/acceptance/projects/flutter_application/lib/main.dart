import 'package:flutter/material.dart';

void main() => runApp(const AcceptanceApp());

class AcceptanceApp extends StatelessWidget {
  const AcceptanceApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Scaffold(
        body: Center(
          child: Text('Arforge Flutter project depth', key: Key('status')),
        ),
      ),
    );
  }
}
