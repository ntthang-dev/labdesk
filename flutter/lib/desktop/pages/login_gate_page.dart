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
  String? _connectedMachineId;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    LabConfig.loadLocalConfig();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _nameController.dispose();
    _studentIdController.dispose();
    super.dispose();
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) return;

    if (!LabConfig.isConfigured) {
      setState(() {
        _errorMessage = 'Chưa cấu hình Google Sheets API. Bấm nút cài đặt ⚙️ góc phải để nhập.';
      });
      return;
    }

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

      final machineId = LabConfig.machineRustdeskId.isNotEmpty
          ? LabConfig.machineRustdeskId
          : (result.machineId ?? '');
      final password = LabConfig.machinePassword.isNotEmpty
          ? LabConfig.machinePassword
          : (result.machinePass ?? '');

      if (machineId.isEmpty) {
        setState(() {
          _isLoading = false;
          _errorMessage = 'Chưa có Machine ID / IP của máy lab';
        });
        return;
      }

      _connectedMachineId = machineId;

      try {
        if (widget.connectHandler != null) {
          await widget.connectHandler!(context, machineId, password: password);
        } else {
          await connect(context, machineId, password: password);
        }
        if (!mounted) return;
        setState(() => _isLoading = false);
        _startPolling();
      } catch (e) {
        if (_activeSessionToken != null) {
          await LabApiService.instance.logout(_activeSessionToken!);
          _activeSessionToken = null;
        }
        if (mounted) {
          setState(() {
            _isLoading = false;
            _errorMessage = 'Lỗi kết nối máy trạm: $e';
          });
        }
      }
    } else {
      setState(() {
        _isLoading = false;
        _errorMessage = result.reason ?? 'Đăng nhập bị từ chối';
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

    if (widget.connectHandler == null &&
        !rustDeskWinManager.hasActiveRemoteDesktopWindows()) {
      _pollTimer?.cancel();
      await LabApiService.instance.logout(token);
      if (mounted) {
        setState(() {
          _activeSessionToken = null;
          _connectedMachineId = null;
        });
      }
      return;
    }

    final status = await LabApiService.instance.checkStatus(token);

    if (!mounted) return;

    if (status == SessionStatus.kicked || status == SessionStatus.expired) {
      _pollTimer?.cancel();
      _activeSessionToken = null;
      _connectedMachineId = null;

      if (widget.connectHandler == null) {
        await rustDeskWinManager.closeAllSubWindows();
      }

      if (mounted) {
        setState(() {
          _errorMessage = status == SessionStatus.kicked
              ? 'Phiên làm việc đã bị Quản trị viên (Admin) ngắt kết nối'
              : 'Phiên làm việc đã hết hạn';
        });
      }
    } else if (status == SessionStatus.notFound) {
      _pollTimer?.cancel();
      _activeSessionToken = null;
      _connectedMachineId = null;
      if (widget.connectHandler == null) {
        await rustDeskWinManager.closeAllSubWindows();
      }
      if (mounted) {
        setState(() {
          _errorMessage = 'Phiên làm việc không tồn tại hoặc đã kết thúc';
        });
      }
    }
  }

  Future<void> _handleDisconnect() async {
    final token = _activeSessionToken;
    _pollTimer?.cancel();
    setState(() => _isLoading = true);

    if (token != null) {
      await LabApiService.instance.logout(token);
    }
    if (widget.connectHandler == null) {
      await rustDeskWinManager.closeAllSubWindows();
    }
    if (mounted) {
      setState(() {
        _activeSessionToken = null;
        _connectedMachineId = null;
        _isLoading = false;
      });
    }
  }

  void _showConfigDialog() {
    final urlCtrl = TextEditingController(text: LabConfig.apiUrl);
    final secretCtrl = TextEditingController(text: LabConfig.sharedSecret);
    final machineCtrl = TextEditingController(
      text: LabConfig.machineRustdeskId.isNotEmpty
          ? LabConfig.machineRustdeskId
          : '100.83.83.70',
    );
    final passCtrl = TextEditingController(
      text: LabConfig.machinePassword.isNotEmpty
          ? LabConfig.machinePassword
          : 'mat_khau_may_lab',
    );

    String? testResult;
    bool isTesting = false;
    bool isTestSuccess = false;

    showDialog(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (dialogCtx, setDialogState) {
            final isDark = Theme.of(dialogCtx).brightness == Brightness.dark;
            return AlertDialog(
              backgroundColor:
                  isDark ? const Color(0xFF24252B) : Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
              title: const Row(
                children: [
                  Icon(Icons.tune, color: Colors.blueAccent),
                  SizedBox(width: 10),
                  Text('Cấu hình Google Sheets & Máy Lab',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                ],
              ),
              content: SizedBox(
                width: 480,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Nhập thông tin kết nối từ Google Apps Script Web App và máy lab:',
                        style: TextStyle(fontSize: 13, color: Colors.grey),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: urlCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Google Apps Script Web App URL',
                          hintText: 'https://script.google.com/macros/s/.../exec',
                          prefixIcon: Icon(Icons.link),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: secretCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Shared Secret Key',
                          hintText: 'your-secret-key-here',
                          prefixIcon: Icon(Icons.key),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: machineCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Machine ID / IP Tailscale',
                          hintText: '100.83.83.70',
                          prefixIcon: Icon(Icons.computer),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: passCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Permanent Password máy Lab',
                          hintText: 'mat_khau_may_lab',
                          prefixIcon: Icon(Icons.lock_outline),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 16),

                      // Test result display
                      if (testResult != null)
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(10),
                          margin: const EdgeInsets.only(bottom: 12),
                          decoration: BoxDecoration(
                            color: isTestSuccess
                                ? const Color(0x1A4CAF50)
                                : const Color(0x1AE53935),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: isTestSuccess
                                  ? Colors.green
                                  : Colors.redAccent,
                            ),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                isTestSuccess
                                    ? Icons.check_circle
                                    : Icons.error_outline,
                                color: isTestSuccess ? Colors.green : Colors.red,
                                size: 18,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  testResult!,
                                  style: TextStyle(
                                    color:
                                        isTestSuccess ? Colors.green : Colors.red,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),

                      // Ping Test Button
                      OutlinedButton.icon(
                        onPressed: isTesting
                            ? null
                            : () async {
                                setDialogState(() {
                                  isTesting = true;
                                  testResult = null;
                                });
                                final res = await LabApiService.instance
                                    .testConnection(
                                        urlCtrl.text.trim(), secretCtrl.text.trim());
                                setDialogState(() {
                                  isTesting = false;
                                  isTestSuccess = res['success'] == true;
                                  testResult = res['message'] as String?;
                                });
                              },
                        icon: isTesting
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.wifi_tethering, size: 18),
                        label: const Text('Kiểm tra kết nối API Google Sheets'),
                      ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(),
                  child: const Text('Hủy'),
                ),
                ElevatedButton(
                  onPressed: () {
                    LabConfig.saveLocalConfig(
                      apiUrl: urlCtrl.text.trim(),
                      sharedSecret: secretCtrl.text.trim(),
                      machineId: machineCtrl.text.trim(),
                      machinePassword: passCtrl.text.trim(),
                    );
                    Navigator.of(dialogCtx).pop();
                    setState(() {
                      _errorMessage = null;
                    });
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Đã lưu cấu hình LabDesk thành công!'),
                        backgroundColor: Colors.green,
                      ),
                    );
                  },
                  child: const Text('Lưu cấu hình'),
                ),
              ],
            );
          },
        );
      },
    );
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
            width: 440,
            padding: const EdgeInsets.all(36),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF2D2D3F) : Colors.white,
              borderRadius: BorderRadius.circular(20),
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
            child: _activeSessionToken != null
                ? _buildActiveSessionView(context, isDark)
                : _buildLoginForm(context, isDark),
          ),
        ),
      ),
    );
  }

  Widget _buildActiveSessionView(BuildContext context, bool isDark) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.check_circle_outline, size: 64, color: Colors.green),
        const SizedBox(height: 16),
        const Text(
          'Đang trong phiên kết nối',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 8),
        Text(
          'Máy lab: $_connectedMachineId',
          style: TextStyle(
            fontSize: 14,
            color: isDark ? Colors.white70 : Colors.black87,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Sinh viên: ${_nameController.text} (${_studentIdController.text})',
          style: const TextStyle(fontSize: 13, color: Colors.grey),
        ),
        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: Colors.green.withOpacity(0.12),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: Colors.green.withOpacity(0.3)),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.green,
                ),
              ),
              SizedBox(width: 10),
              Text(
                'Kiểm tra phiên mỗi 12 giây với máy chủ',
                style: TextStyle(color: Colors.green, fontSize: 12),
              ),
            ],
          ),
        ),
        const SizedBox(height: 28),
        SizedBox(
          width: double.infinity,
          height: 46,
          child: ElevatedButton.icon(
            onPressed: _isLoading ? null : _handleDisconnect,
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.redAccent,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            icon: const Icon(Icons.power_settings_new),
            label: _isLoading
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Ngắt kết nối & Đăng xuất',
                    style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }

  Widget _buildLoginForm(BuildContext context, bool isDark) {
    return Form(
      key: _formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header with Settings Gear
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const SizedBox(width: 40),
              Image.asset(
                'res/icon.png',
                width: 64,
                height: 64,
                errorBuilder: (_, __, ___) => Icon(
                  Icons.computer,
                  size: 56,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.settings_outlined),
                tooltip: 'Cấu hình Google Sheets & Lab',
                onPressed: _showConfigDialog,
              ),
            ],
          ),
          const SizedBox(height: 12),
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
          const SizedBox(height: 20),

          // Alert banner if not configured
          if (!LabConfig.isConfigured)
            InkWell(
              onTap: _showConfigDialog,
              borderRadius: BorderRadius.circular(10),
              child: Container(
                padding: const EdgeInsets.all(12),
                margin: const EdgeInsets.only(bottom: 20),
                decoration: BoxDecoration(
                  color: Colors.amber.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.amber.shade700),
                ),
                child: Row(
                  children: [
                    Icon(Icons.warning_amber_rounded,
                        color: Colors.amber.shade800, size: 22),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Chưa cấu hình Google Sheets API.\nBấm vào đây để nhập URL Apps Script.',
                        style: TextStyle(
                          color: isDark ? Colors.amber.shade200 : Colors.amber.shade900,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    Icon(Icons.arrow_forward_ios,
                        size: 14, color: Colors.amber.shade800),
                  ],
                ),
              ),
            ),

          // Full Name field
          TextFormField(
            controller: _nameController,
            decoration: InputDecoration(
              labelText: 'Họ và tên',
              hintText: 'Nguyễn Văn A',
              prefixIcon: const Icon(Icons.person_outline),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor:
                  isDark ? const Color(0xFF1E1E2E) : const Color(0xFFF5F5F7),
            ),
            validator: (v) =>
                (v == null || v.trim().isEmpty) ? 'Vui lòng nhập họ và tên' : null,
            textInputAction: TextInputAction.next,
            enabled: !_isLoading,
          ),
          const SizedBox(height: 16),

          // Student ID field
          TextFormField(
            controller: _studentIdController,
            decoration: InputDecoration(
              labelText: 'Mã số sinh viên (MSSV)',
              hintText: '20210001',
              prefixIcon: const Icon(Icons.badge_outlined),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor:
                  isDark ? const Color(0xFF1E1E2E) : const Color(0xFFF5F5F7),
            ),
            validator: (v) =>
                (v == null || v.trim().isEmpty) ? 'Vui lòng nhập MSSV' : null,
            textInputAction: TextInputAction.done,
            onFieldSubmitted: (_) => _handleLogin(),
            enabled: !_isLoading,
          ),
          const SizedBox(height: 20),

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
                backgroundColor: Theme.of(context).colorScheme.primary,
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
                      'Đăng nhập vào phòng Lab',
                      style: TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w600),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
