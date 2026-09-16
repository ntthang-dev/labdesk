import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';
import 'package:flutter_hbb/desktop/pages/login_gate_page.dart';
import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';

/// Standalone preview runner for LabDesk.
/// Runs natively on macOS without requiring native RustDesk FFI.
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  LabConfig.loadLocalConfig();

  await windowManager.ensureInitialized();

  const windowOptions = WindowOptions(
    size: Size(480, 750),
    minimumSize: Size(400, 600),
    center: true,
    title: 'LabDesk - Lab Remote Access',
    titleBarStyle: TitleBarStyle.normal,
  );

  runApp(const LabPreviewApp());

  windowManager.waitUntilReadyToShow(windowOptions, () async {
    await windowManager.show();
    await windowManager.focus();
  });
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
          // Connection handler for macOS test
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                'Đã kết nối tới máy lab: $machineId (Pass: ${password?.isNotEmpty == true ? '***' : 'none'})',
              ),
              backgroundColor: Colors.green,
            ),
          );
        },
      ),
    );
  }
}
