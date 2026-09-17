import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hbb/common.dart';
import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';
import 'package:flutter_hbb/models/platform_model.dart';
import 'package:flutter_hbb/utils/multi_window_manager.dart';
import 'package:window_manager/window_manager.dart';

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

class _LoginGatePageState extends State<LoginGatePage> with WindowListener {
  final _nameController = TextEditingController();
  final _studentIdController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  bool _isLoading = false;
  String? _errorMessage;
  String? _activeSessionToken;
  String? _connectedMachineName;
  Timer? _pollTimer;
  DateTime? _connectedAt;
  bool _isViewer = false;

  @override
  void initState() {
    super.initState();
    LabConfig.loadLocalConfig();
    if (widget.connectHandler == null) {
      windowManager.addListener(this);
    }
  }

  @override
  void dispose() {
    if (widget.connectHandler == null) {
      windowManager.removeListener(this);
    }
    _pollTimer?.cancel();
    _nameController.dispose();
    _studentIdController.dispose();
    super.dispose();
  }

  // main.dart sets windowManager.setPreventClose(true) so every RustDesk window
  // can decide how to react; the normal main window then just hides to the tray
  // (see DesktopTab.onWindowClose in tabbar_widget.dart). LabDesk isn't a
  // background service on student machines, so hiding leaves an invisible,
  // still-running app with no way back in and no session cleanup - the app
  // looks "stuck" exactly like this was reported. Free the slot, then force-quit.
  @override
  void onWindowClose() async {
    final token = _activeSessionToken;
    // A viewer doesn't own the row (it's the controller's), so their
    // "logout" must never free it - see _handleLogin's view-mode comment.
    if (token != null && !_isViewer) {
      await LabApiService.instance.logout(token);
    }
    bind.mainOnMainWindowClose();
    await windowManager.destroy();
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) return;

    if (!LabConfig.isConfigured) {
      setState(() {
        _errorMessage = 'Hệ thống phòng lab đang bận hoặc chưa sẵn sàng. Vui lòng liên hệ Quản trị viên.';
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

      // The sheet row is authoritative: it is what the admin edits when a lab
      // machine changes. The baked-in values are only a fallback.
      final machineId = (result.machineId?.isNotEmpty ?? false)
          ? result.machineId!
          : LabConfig.machineRustdeskId;
      final password = (result.machinePass?.isNotEmpty ?? false)
          ? result.machinePass!
          : LabConfig.machinePassword;

      if (machineId.isEmpty) {
        setState(() {
          _isLoading = false;
          _errorMessage = 'Chưa có thông tin máy trạm được chỉ định';
        });
        return;
      }

      _connectedMachineName = result.machineName ?? 'Máy phòng Lab';
      _isViewer = result.isViewOnly;

      // `view-only` is a per-peer setting RustDesk itself enforces (blocks
      // sending keyboard/mouse before the first frame - see
      // input_model.dart's `if (isViewOnly) return;` guards). It persists
      // per machine_id, so it must be set explicitly both ways every time:
      // a later controller session must not inherit a stale 'Y' from an
      // earlier view join.
      if (widget.connectHandler == null) {
        bind.mainSetPeerOptionSync(
            id: machineId, key: 'view-only', value: _isViewer ? 'Y' : 'N');
      }

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
        if (_activeSessionToken != null && !_isViewer) {
          await LabApiService.instance.logout(_activeSessionToken!);
          _activeSessionToken = null;
        }
        if (mounted) {
          // Never interpolate `e` into a student-facing message: exceptions like
          // SocketException embed the target host/IP in their toString().
          setState(() {
            _isLoading = false;
            _errorMessage =
                'Không thể kết nối tới máy phòng lab. Vui lòng thử lại hoặc liên hệ Quản trị viên.';
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
    _connectedAt = DateTime.now();
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

    final connectedAt = _connectedAt;
    final settled = connectedAt == null ||
        DateTime.now().difference(connectedAt) > const Duration(seconds: 20);

    if (settled &&
        widget.connectHandler == null &&
        !rustDeskWinManager.hasActiveRemoteDesktopWindows()) {
      _pollTimer?.cancel();
      _connectedAt = null;
      if (!_isViewer) {
        await LabApiService.instance.logout(token);
      }
      if (mounted) {
        setState(() {
          _activeSessionToken = null;
          _connectedMachineName = null;
          _isViewer = false;
        });
      }
      return;
    }

    final status = await LabApiService.instance.checkStatus(token);

    if (!mounted) return;

    if (status == SessionStatus.kicked || status == SessionStatus.expired) {
      _pollTimer?.cancel();
      _activeSessionToken = null;
      _connectedMachineName = null;
      _connectedAt = null;
      _isViewer = false;

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
      _connectedMachineName = null;
      _connectedAt = null;
      _isViewer = false;
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
    _connectedAt = null;
    setState(() => _isLoading = true);

    // A viewer never owns the row - logging them out here would free the
    // machine out from under the actual controller.
    if (token != null && !_isViewer) {
      await LabApiService.instance.logout(token);
    }
    if (widget.connectHandler == null) {
      await rustDeskWinManager.closeAllSubWindows();
    }
    if (mounted) {
      setState(() {
        _activeSessionToken = null;
        _connectedMachineName = null;
        _isViewer = false;
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor:
          isDark ? const Color(0xFF1E1E2E) : const Color(0xFFF5F5F7),
      // main.dart's WindowOptions uses TitleBarStyle.hidden (frameless, no OS
      // chrome) so DesktopTab normally draws the close/minimize/drag strip -
      // but LoginGatePage is used directly as `home`, bypassing DesktopTab
      // entirely. Without this, the window has no visible close control at
      // all, most noticeably on Windows where (unlike macOS) a frameless
      // window has no fallback native buttons whatsoever.
      body: Stack(
        children: [
          Center(
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
          if (widget.connectHandler == null) _buildWindowControls(isDark),
        ],
      ),
    );
  }

  Widget _buildWindowControls(bool isDark) {
    final iconColor = isDark ? Colors.white60 : Colors.black45;
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      height: 36,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onPanStart: (_) => windowManager.startDragging(),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            IconButton(
              icon: Icon(Icons.close, size: 18, color: iconColor),
              tooltip: 'Đóng',
              splashRadius: 16,
              onPressed: () => windowManager.close(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildActiveSessionView(BuildContext context, bool isDark) {
    final accent = _isViewer ? Colors.blueAccent : Colors.green;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          _isViewer ? Icons.visibility_outlined : Icons.check_circle_outline,
          size: 64,
          color: accent,
        ),
        const SizedBox(height: 16),
        Text(
          _isViewer ? 'Đang xem (không điều khiển được)' : 'Đang trong phiên kết nối',
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        if (_isViewer) ...[
          const SizedBox(height: 6),
          Text(
            'Máy đang có bạn khác điều khiển. Bạn chỉ xem được màn hình, không gõ phím hay dùng chuột được.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              color: isDark ? Colors.white60 : Colors.black54,
            ),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          'Máy: ${_connectedMachineName ?? "Máy phòng Lab"}',
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
            color: accent.withOpacity(0.12),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: accent.withOpacity(0.3)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: accent,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                'Kiểm tra phiên mỗi 12 giây với máy chủ',
                style: TextStyle(color: accent, fontSize: 12),
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
                : Text(_isViewer ? 'Rời khỏi' : 'Ngắt kết nối & Đăng xuất',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
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
          // Header Logo (Centered, no settings icon)
          Center(
            child: Image.asset(
              'res/icon.png',
              width: 64,
              height: 64,
              errorBuilder: (_, __, ___) => Icon(
                Icons.computer,
                size: 56,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
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
          const SizedBox(height: 10),
          // A first-time student has no other instructions in front of them
          // (no README, no settings screen) - this line is the entire manual.
          Text(
            'Nhập đúng Họ tên và MSSV như trong danh sách lớp, hệ thống sẽ tự kết nối vào máy phòng Lab.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              height: 1.4,
              color: isDark ? Colors.white54 : Colors.black45,
            ),
          ),
          const SizedBox(height: 24),

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
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _errorMessage!,
                          style: const TextStyle(
                            color: Colors.red,
                            fontSize: 13,
                          ),
                        ),
                        if (LabConfig.supportContact.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            'Cần hỗ trợ? Liên hệ: ${LabConfig.supportContact}',
                            style: TextStyle(
                              color: Colors.red.withOpacity(0.75),
                              fontSize: 12,
                              fontStyle: FontStyle.italic,
                            ),
                          ),
                        ],
                      ],
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
