import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hbb/common.dart';
import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';
import 'package:flutter_hbb/models/platform_model.dart';
import 'package:flutter_hbb/utils/multi_window_manager.dart';
import 'package:window_manager/window_manager.dart';
import 'package:url_launcher/url_launcher.dart';

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
  String? _connectedFullName;
  String? _connectedMachineId;
  String? _connectedPassword;
  Timer? _pollTimer;
  DateTime? _connectedAt;
  bool _isViewer = false;
  String? _updateDownloadUrl; // set when force_update or updateAvailable
  int? _queuePosition;
  String? _controllerName;
  String? _controllerStudentId;
  DateTime? _expiresAt;
  Timer? _countdownTimer;
  Duration? _timeRemaining;

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
    _countdownTimer?.cancel();
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
        _errorMessage =
            'Hệ thống phòng lab đang bận hoặc chưa sẵn sàng. Vui lòng liên hệ Quản trị viên.';
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
      _connectedMachineId = machineId;
      _connectedPassword = password;
      // The roster name, not the (possibly mistyped) one in the text field.
      _connectedFullName = result.fullName ?? _nameController.text.trim();
      _isViewer = result.isViewOnly;
      _updateDownloadUrl = result.updateAvailable ? result.downloadUrl : null;
      _queuePosition = result.queuePosition;
      _controllerName = result.controllerName;
      _controllerStudentId = result.controllerStudentId;
      _expiresAt = result.expiresAt;
      _startCountdown();

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
        if (result.queuePosition != null) {
          _errorMessage =
              '${_errorMessage!} Bạn đang xếp hàng, vị trí #${result.queuePosition}. Hãy thử đăng nhập lại sau vài phút.';
        }
        _updateDownloadUrl = result.forceUpdate ? result.downloadUrl : null;
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

  // Server enforces the actual time limit (Code.gs' expires_at check in
  // handleStatus); this is purely so the student can *see* it coming instead
  // of being disconnected with no warning.
  void _startCountdown() {
    _countdownTimer?.cancel();
    final expiresAt = _expiresAt;
    if (expiresAt == null) {
      setState(() => _timeRemaining = null);
      return;
    }
    void tick() {
      final remaining = expiresAt.difference(DateTime.now());
      if (mounted) {
        setState(() =>
            _timeRemaining = remaining.isNegative ? Duration.zero : remaining);
      }
    }

    tick();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) => tick());
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
          _connectedFullName = null;
          _isViewer = false;
          _queuePosition = null;
          _controllerName = null;
          _controllerStudentId = null;
          _expiresAt = null;
          _countdownTimer?.cancel();
          _timeRemaining = null;
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
      _connectedFullName = null;
      _connectedAt = null;
      _isViewer = false;
      _queuePosition = null;
      _controllerName = null;
      _controllerStudentId = null;
      _expiresAt = null;
      _countdownTimer?.cancel();
      _timeRemaining = null;

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
      _connectedFullName = null;
      _connectedAt = null;
      _isViewer = false;
      _queuePosition = null;
      _controllerName = null;
      _controllerStudentId = null;
      _expiresAt = null;
      _countdownTimer?.cancel();
      _timeRemaining = null;
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
        _connectedFullName = null;
        _isViewer = false;
        _queuePosition = null;
        _controllerName = null;
        _controllerStudentId = null;
        _expiresAt = null;
        _countdownTimer?.cancel();
        _timeRemaining = null;
        _isLoading = false;
      });
    }
  }

  // RustDesk's file transfer engine (chunked transfer, resume, path-traversal
  // protection) is unmodified and already safe under lab mode - the file
  // manager window's title/tab go through the same getWindowNameWithId /
  // DesktopTab.tablabelGetter this file already gated in 02949cbda/b48682f84,
  // so it never shows the host's id. This just gives it a visible entry
  // point, since students have no other way to find "Transfer file" (it's
  // buried in the remote toolbar's Control Actions menu).
  Future<void> _openFileTransfer() async {
    final machineId = _connectedMachineId;
    if (machineId == null) return;
    await connect(context, machineId,
        isFileTransfer: true, password: _connectedPassword);
  }

  // These are UserDefaultConfig keys (libs/hbb_common/src/config.rs), i.e.
  // global defaults used for the *next* session - not the live one, which
  // already has its own toolbar (Display menu) for the same settings.
  // Setting them here just means a student who reconnects doesn't have to
  // redo their preference every time.
  Future<void> _showDisplaySettings(BuildContext context, bool isDark) async {
    final quality = await bind.mainGetOption(key: 'image_quality');
    final viewStyle = await bind.mainGetOption(key: 'view_style');
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cài đặt hiển thị'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Chất lượng hình ảnh (áp dụng cho lần kết nối tiếp theo)',
                style: TextStyle(
                    fontSize: 12,
                    color: isDark ? Colors.white60 : Colors.black54)),
            const SizedBox(height: 6),
            ...[
              ('best', 'Ưu tiên chất lượng'),
              ('balanced', 'Cân bằng'),
              ('low', 'Ưu tiên tốc độ phản hồi'),
            ].map((opt) => RadioListTile<String>(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(opt.$2),
                  value: opt.$1,
                  groupValue: quality.isEmpty ? 'balanced' : quality,
                  onChanged: (v) async {
                    if (v == null) return;
                    await bind.mainSetOption(key: 'image_quality', value: v);
                    if (ctx.mounted) Navigator.of(ctx).pop();
                  },
                )),
            const Divider(height: 20),
            Text('Chế độ hiển thị màn hình',
                style: TextStyle(
                    fontSize: 12,
                    color: isDark ? Colors.white60 : Colors.black54)),
            const SizedBox(height: 6),
            ...[
              ('original', 'Kích thước gốc'),
              ('adaptive', 'Vừa khung cửa sổ'),
            ].map((opt) => RadioListTile<String>(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(opt.$2),
                  value: opt.$1,
                  groupValue: viewStyle.isEmpty ? 'original' : viewStyle,
                  onChanged: (v) async {
                    if (v == null) return;
                    await bind.mainSetOption(key: 'view_style', value: v);
                    if (ctx.mounted) Navigator.of(ctx).pop();
                  },
                )),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Đóng')),
        ],
      ),
    );
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

  // Purely informational - handleStatus() in Code.gs is what actually ends
  // the session at expires_at. This just gives the student advance warning
  // instead of being cut off with no clock to have watched.
  Widget _buildCountdown(bool isDark) {
    final remaining = _timeRemaining!;
    final minutes = remaining.inMinutes;
    final seconds = remaining.inSeconds % 60;
    final label =
        '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
    final low = remaining.inMinutes < 5;
    final color =
        low ? Colors.orange : (isDark ? Colors.white70 : Colors.black54);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: low ? Colors.orange.withOpacity(0.12) : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        border: low ? Border.all(color: Colors.orange.withOpacity(0.4)) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.timer_outlined, size: 15, color: color),
          const SizedBox(width: 6),
          Text(
            low
                ? 'Phiên sắp hết hạn: còn $label'
                : 'Thời gian phiên còn lại: $label',
            style: TextStyle(
                color: color,
                fontSize: 12.5,
                fontWeight: low ? FontWeight.w700 : FontWeight.w500),
          ),
        ],
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
          _isViewer
              ? 'Đang xem (không điều khiển được)'
              : 'Đang trong phiên kết nối',
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        if (_isViewer) ...[
          const SizedBox(height: 6),
          Text(
            (_controllerName ?? '').isNotEmpty
                ? 'Đang được điều khiển bởi: $_controllerName${_controllerStudentId != null ? " ($_controllerStudentId)" : ""}. Bạn chỉ xem được màn hình, không gõ phím hay dùng chuột được.'
                : 'Máy đang có bạn khác điều khiển. Bạn chỉ xem được màn hình, không gõ phím hay dùng chuột được.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              color: isDark ? Colors.white60 : Colors.black54,
            ),
          ),
          if (_queuePosition != null) ...[
            const SizedBox(height: 6),
            Text(
              _queuePosition == 1
                  ? 'Bạn là người tiếp theo trong hàng đợi.'
                  : 'Vị trí của bạn trong hàng đợi: #$_queuePosition',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: Colors.blueAccent,
              ),
            ),
          ],
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
          'Sinh viên: ${_connectedFullName ?? _nameController.text} (${_studentIdController.text})',
          style: const TextStyle(fontSize: 13, color: Colors.grey),
        ),
        if (_timeRemaining != null) ...[
          const SizedBox(height: 14),
          _buildCountdown(isDark),
        ],
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
        if (!_isViewer && widget.connectHandler == null) ...[
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _isLoading ? null : _openFileTransfer,
                  icon: const Icon(Icons.folder_open, size: 18),
                  label: const Text('Truyền file'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _isLoading
                      ? null
                      : () => _showDisplaySettings(context, isDark),
                  icon: const Icon(Icons.tune, size: 18),
                  label: const Text('Cài đặt'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                ),
              ),
            ],
          ),
        ],
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
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Colors.white))
                : Text(_isViewer ? 'Rời khỏi' : 'Ngắt kết nối & Đăng xuất',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
        ),
        if ((_updateDownloadUrl ?? '').isNotEmpty) ...[
          const SizedBox(height: 14),
          InkWell(
            onTap: () => launchUrl(Uri.parse(_updateDownloadUrl!),
                mode: LaunchMode.externalApplication),
            child: Text(
              '🔔 Có bản LabDesk mới hơn — bấm để tải',
              style: TextStyle(
                color: isDark ? Colors.white54 : Colors.black45,
                fontSize: 12,
                decoration: TextDecoration.underline,
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildUserGuide(bool isDark) {
    const steps = [
      '1. Nhập đúng Họ tên và MSSV như trong danh sách lớp.',
      '2. Bấm "Đăng nhập vào phòng Lab" — hệ thống tự kết nối, không cần nhập gì thêm.',
      '3. Nếu máy đang có người dùng, bạn sẽ được vào ở chế độ chỉ xem (không điều khiển được).',
      '4. Trong phiên: nút "Truyền file" để chuyển file qua lại; nút "Cài đặt" để đổi chất lượng hình ảnh.',
      '5. Xong việc, bấm "Ngắt kết nối & Đăng xuất" để nhường máy cho bạn khác — đừng chỉ đóng cửa sổ.',
      'macOS: nếu hệ thống báo "không thể mở vì không xác định được nhà phát triển", vào System Settings → Privacy & Security → cuộn xuống → bấm "Open Anyway".',
    ];
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 8),
        title: Text(
          '📘 Hướng dẫn sử dụng',
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            color: isDark ? Colors.white70 : Colors.black54,
          ),
        ),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: steps
                  .map((s) => Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Text(
                          s,
                          style: TextStyle(
                            fontSize: 12,
                            height: 1.4,
                            color: isDark ? Colors.white60 : Colors.black54,
                          ),
                        ),
                      ))
                  .toList(),
            ),
          ),
        ],
      ),
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
              // Not 'res/icon.png': that path isn't declared under pubspec's
              // `assets:` (only flutter/assets/ is), so it always 404'd here
              // and silently fell through to errorBuilder below - the logo
              // never actually rendered.
              'assets/icon.png',
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
          const SizedBox(height: 4),
          Text(
            'Phiên bản ${LabConfig.appVersion}',
            style: TextStyle(
              fontSize: 10.5,
              color: isDark ? Colors.white38 : Colors.black38,
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
          const SizedBox(height: 4),
          _buildUserGuide(isDark),
          const SizedBox(height: 20),

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
            validator: (v) => (v == null || v.trim().isEmpty)
                ? 'Vui lòng nhập họ và tên'
                : null,
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
                  const Icon(Icons.error_outline, color: Colors.red, size: 20),
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
                        if ((_updateDownloadUrl ?? '').isNotEmpty) ...[
                          const SizedBox(height: 10),
                          OutlinedButton.icon(
                            onPressed: () => launchUrl(
                                Uri.parse(_updateDownloadUrl!),
                                mode: LaunchMode.externalApplication),
                            icon: const Icon(Icons.download, size: 16),
                            label: const Text('Tải bản mới nhất'),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: Colors.red,
                              side: const BorderSide(color: Colors.red),
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
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
