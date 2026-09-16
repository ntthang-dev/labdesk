import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hbb/common.dart';
import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';
import 'package:flutter_hbb/utils/multi_window_manager.dart';

typedef ConnectHandler = Future<void> Function(
  BuildContext context,
  String id, {
  String? password,
});

class LoginGatePage extends StatefulWidget {
  final ConnectHandler? connectHandler;
  const LoginGatePage({Key? key, this.connectHandler}) : super(key: key);

  @override
  State<LoginGatePage> createState() => _LoginGatePageState();
}

class _LoginGatePageState extends State<LoginGatePage> {
  final _nameController = TextEditingController();
  final _studentIdController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  bool _isLoading = false;
  String? _errorMessage;
  String? _activeSessionToken;
  Timer? _pollTimer;

  @override
  void dispose() {
    _pollTimer?.cancel();
    _nameController.dispose();
    _studentIdController.dispose();
    super.dispose();
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    final result = await LabApiService.instance.login(
      _studentIdController.text.trim(),
      _nameController.text.trim(),
    );

    if (!mounted) return;

    if (result.allowed) {
      _activeSessionToken = result.sessionToken;

      // Determine which machine to connect to
      final machineId =
          LabConfig.machineRustdeskId.isNotEmpty
              ? LabConfig.machineRustdeskId
              : (result.machineId ?? '');
      final password =
          LabConfig.machinePassword.isNotEmpty
              ? LabConfig.machinePassword
              : (result.machinePass ?? '');

      if (machineId.isEmpty) {
        setState(() {
          _isLoading = false;
          _errorMessage = 'No machine ID configured';
        });
        return;
      }

      try {
        // Connect via connectHandler (if mock preview) or FFI
        if (widget.connectHandler != null) {
          await widget.connectHandler!(context, machineId, password: password);
        } else {
          await connect(context, machineId, password: password);
        }
        if (!mounted) return;
        setState(() => _isLoading = false);
        // Start polling for session status
        _startPolling();
      } catch (e) {
        // If connection fails immediately, release the session slot
        if (_activeSessionToken != null) {
          await LabApiService.instance.logout(_activeSessionToken!);
          _activeSessionToken = null;
        }
        if (mounted) {
          setState(() {
            _isLoading = false;
            _errorMessage = 'Connection error: $e';
          });
        }
      }
    } else {
      setState(() {
        _isLoading = false;
        _errorMessage = result.reason ?? 'Login denied';
      });
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 12), (_) async {
      await _pollStatus();
    });
  }

  Future<void> _pollStatus() async {
    final token = _activeSessionToken;
    if (token == null) {
      _pollTimer?.cancel();
      return;
    }

    // Check if the remote window is still open (when running under real window manager)
    if (widget.connectHandler == null &&
        !rustDeskWinManager.hasActiveRemoteDesktopWindows()) {
      // User closed the remote window — call logout
      _pollTimer?.cancel();
      await LabApiService.instance.logout(token);
      _activeSessionToken = null;
      return;
    }

    final status = await LabApiService.instance.checkStatus(token);

    if (!mounted) return;

    if (status == SessionStatus.kicked || status == SessionStatus.expired) {
      _pollTimer?.cancel();
      _activeSessionToken = null;

      // Close all remote desktop windows
      if (widget.connectHandler == null) {
        await rustDeskWinManager.closeAllSubWindows();
      }

      if (mounted) {
        setState(() {
          _errorMessage = status == SessionStatus.kicked
              ? 'Your session was terminated by the administrator'
              : 'Your session has expired';
        });
      }
    } else if (status == SessionStatus.notFound) {
      _pollTimer?.cancel();
      _activeSessionToken = null;
      await rustDeskWinManager.closeAllSubWindows();
      if (mounted) {
        setState(() {
          _errorMessage = 'Session not found — please login again';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor:
          isDark ? const Color(0xFF1E1E2E) : const Color(0xFFF5F5F7),
      body: Center(
        child: SingleChildScrollView(
          child: Container(
            width: 420,
            padding: const EdgeInsets.all(40),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF2D2D3F) : Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                BoxShadow(
                  color: isDark
                      ? const Color(0x4D000000)
                      : const Color(0x1A000000),
                  blurRadius: 24,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Logo / Title
                  Icon(
                    Icons.computer,
                    size: 56,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  Text(
                    'LabDesk',
                    style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                      color: isDark ? Colors.white : Colors.black87,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Hệ thống đăng nhập phòng Lab',
                    style: TextStyle(
                      fontSize: 14,
                      color: isDark ? Colors.white60 : Colors.black54,
                    ),
                  ),
                  const SizedBox(height: 28),

                  // Full Name field
                  TextFormField(
                    controller: _nameController,
                    decoration: InputDecoration(
                      labelText: 'Full Name',
                      hintText: 'Nguyen Van A',
                      prefixIcon: const Icon(Icons.person_outline),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      filled: true,
                      fillColor: isDark
                          ? const Color(0xFF1E1E2E)
                          : const Color(0xFFF5F5F7),
                    ),
                    validator: (v) =>
                        (v == null || v.trim().isEmpty) ? 'Required' : null,
                    textInputAction: TextInputAction.next,
                    enabled: !_isLoading,
                  ),
                  const SizedBox(height: 16),

                  // Student ID field
                  TextFormField(
                    controller: _studentIdController,
                    decoration: InputDecoration(
                      labelText: 'Student ID (MSSV)',
                      hintText: '20210001',
                      prefixIcon: const Icon(Icons.badge_outlined),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      filled: true,
                      fillColor: isDark
                          ? const Color(0xFF1E1E2E)
                          : const Color(0xFFF5F5F7),
                    ),
                    validator: (v) =>
                        (v == null || v.trim().isEmpty) ? 'Required' : null,
                    textInputAction: TextInputAction.done,
                    onFieldSubmitted: (_) => _handleLogin(),
                    enabled: !_isLoading,
                  ),
                  const SizedBox(height: 24),

                  // Error message
                  if (_errorMessage != null)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: const Color(0x1AE53935),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: const Color(0x4DE53935),
                        ),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.error_outline,
                              color: Colors.red, size: 20),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _errorMessage!,
                              style: const TextStyle(
                                color: Colors.red,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),

                  // Login button
                  SizedBox(
                    width: double.infinity,
                    height: 48,
                    child: ElevatedButton(
                      onPressed: _isLoading ? null : _handleLogin,
                      style: ElevatedButton.styleFrom(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        backgroundColor:
                            Theme.of(context).colorScheme.primary,
                        foregroundColor: Colors.white,
                      ),
                      child: _isLoading
                          ? const SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text(
                              'Connect to Lab',
                              style: TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w600),
                            ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
