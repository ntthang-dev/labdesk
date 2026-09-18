import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'lab_api_service.dart';

/// Accent colour for every LabDesk-specific surface. Deliberately different
/// from RustDesk's own `MyTheme.accent` (0xFF0071FF) so students can tell the
/// two apps apart at a glance.
const Color kLabDeskAccent = Color(0xFF5E5CE6);

/// The remote desktop opens in its own window, which means its own Flutter
/// engine and its own isolate - none of `LoginGatePage`'s state reaches it.
/// Threading `expires_at` through `newRemoteDesktop` would mean changing
/// `newSession`'s signature and the sub-window argument map, both shared with
/// upstream RustDesk. Writing it to a tiny file that any isolate can read
/// keeps the change entirely inside lab-only code.
///
/// This clock is presentational only: the session is actually ended by the
/// server (`expires_at` in `handleStatus`), which the login window acts on.
/// A stale file can therefore never keep a student connected past their time.
class LabSessionClock {
  static File get _file {
    final home = Platform.environment['HOME'] ??
        Platform.environment['USERPROFILE'] ??
        '.';
    return File('$home/.labdesk_session.json');
  }

  static void write(DateTime? expiresAt) {
    try {
      if (expiresAt == null) {
        final f = _file;
        if (f.existsSync()) f.deleteSync();
        return;
      }
      _file.writeAsStringSync(
          jsonEncode({'expires_at': expiresAt.toIso8601String()}));
    } catch (_) {}
  }

  static DateTime? read() {
    try {
      final f = _file;
      if (!f.existsSync()) return null;
      final data = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
      final raw = data['expires_at'];
      if (raw is! String || raw.isEmpty) return null;
      return DateTime.tryParse(raw);
    } catch (_) {
      return null;
    }
  }
}

/// Floating "time left in your session" chip for the remote desktop window.
/// Renders nothing at all when not in lab mode or when the lab has no time
/// limit configured, so the default RustDesk session is untouched.
class LabSessionCountdown extends StatefulWidget {
  const LabSessionCountdown({super.key});

  @override
  State<LabSessionCountdown> createState() => _LabSessionCountdownState();
}

class _LabSessionCountdownState extends State<LabSessionCountdown> {
  DateTime? _expiresAt;
  Duration? _left;
  Timer? _timer;
  // Each threshold fires once per session, so a student is warned rather than
  // nagged every second for the last five minutes.
  final Set<int> _warned = {};

  static const List<int> _warnAtMinutes = [10, 5, 1];

  @override
  void initState() {
    super.initState();
    _expiresAt = LabSessionClock.read();
    if (_expiresAt != null) {
      _tick();
      _timer = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _tick() {
    final expiresAt = _expiresAt;
    if (expiresAt == null) return;
    final left = expiresAt.difference(DateTime.now());
    final minutesLeft = left.inSeconds <= 0 ? 0 : (left.inSeconds / 60).ceil();
    for (final threshold in _warnAtMinutes) {
      if (minutesLeft == threshold && _warned.add(threshold)) {
        _alert(threshold);
      }
    }
    if (mounted) setState(() => _left = left);
  }

  void _alert(int minutes) {
    // SystemSound needs no extra dependency, but it is a no-op on some
    // desktop platforms - the banner below is what students can always rely
    // on, the sound is a bonus where the OS provides one.
    SystemSound.play(SystemSoundType.alert);
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(
      backgroundColor: minutes <= 1 ? Colors.red : Colors.orange[800],
      duration: const Duration(seconds: 8),
      content: Text(
        minutes <= 1
            ? 'Phiên của bạn sắp hết! Còn dưới 1 phút — hãy lưu lại công việc ngay.'
            : 'Phiên của bạn còn $minutes phút. Hãy chuẩn bị lưu lại công việc.',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
    ));
  }

  String _format(Duration d) {
    if (d.isNegative) return '00:00';
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final left = _left;
    if (!LabConfig.isLabMode || _expiresAt == null || left == null) {
      return const SizedBox.shrink();
    }
    final isCritical = left.inMinutes < 5;
    return Positioned(
      top: 8,
      right: 12,
      child: IgnorePointer(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: (isCritical ? Colors.red[700] : Colors.black)
                ?.withOpacity(0.72),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
                color: isCritical ? Colors.redAccent : kLabDeskAccent,
                width: 1.5),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(isCritical ? Icons.warning_amber : Icons.timer_outlined,
                  size: 16, color: Colors.white),
              const SizedBox(width: 6),
              Text(
                'Còn ${_format(left)}',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
