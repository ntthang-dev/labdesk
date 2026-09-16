import 'package:flutter/material.dart';
import 'package:flutter_hbb/desktop/pages/login_gate_page.dart';

/// Standalone preview runner for Lab Login UI.
/// Run locally on macOS/Chrome without requiring native RustDesk FFI:
///   flutter run -d macos -t lib/main_lab_preview.dart
///   flutter run -d chrome -t lib/main_lab_preview.dart
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const LabPreviewApp());
}

class LabPreviewApp extends StatelessWidget {
  const LabPreviewApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LabDesk - Lab Remote Access',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorSchemeSeed: Colors.blue,
      ),
      darkTheme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorSchemeSeed: Colors.blue,
      ),
      themeMode: ThemeMode.system,
      home: LoginGatePage(
        connectHandler: (context, machineId, {password}) async {
          // Mock connection for local UI preview
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Mock connected to lab machine: $machineId (Pass: ${password?.isNotEmpty == true ? '***' : 'none'})',
              ),
              backgroundColor: Colors.green,
            ),
          );
        },
      ),
    );
  }
}
