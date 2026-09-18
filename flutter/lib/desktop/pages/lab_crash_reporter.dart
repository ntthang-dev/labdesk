import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'lab_api_service.dart';
import 'lab_session_clock.dart';

/// Hooks Flutter's two global error surfaces and forwards crashes to the
/// existing `action=crash_report` endpoint (apps_script/src/25_diagnostics.gs),
/// so "cráh gửi qua lại về đường feedback" (an admin's own words: crashes
/// should flow back through the same reporting channel) happens without a
/// student ever having to notice, describe, or report anything themselves.
///
/// Call once, as early as possible in main() - see main.dart. No-ops
/// entirely outside lab mode.
class LabCrashReporter {
  static bool _installed = false;

  // A runaway error loop (the same exception firing every frame) must not
  // turn into hundreds of Sheets rows or hundreds of outbound requests per
  // second - cap total reports per process lifetime, generously high enough
  // to still capture a real crash's first several occurrences.
  static int _sentCount = 0;
  static const int _maxReportsPerSession = 20;

  static void install() {
    if (_installed || !LabConfig.isLabMode) return;
    _installed = true;

    final previousOnError = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      _report(details.exception, details.stack, source: 'flutter');
      previousOnError?.call(details);
    };

    final previousPlatformOnError = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      _report(error, stack, source: 'platform');
      // Not handled by us - let any previously-registered handler (or the
      // default) still run/decide, we're only ever adding a side channel.
      return previousPlatformOnError?.call(error, stack) ?? false;
    };
  }

  static void _report(Object error, StackTrace? stack,
      {required String source}) {
    if (_sentCount >= _maxReportsPerSession) return;
    _sentCount++;
    // Fire-and-forget: a crash handler that can itself throw or block is
    // worse than no crash handler. Every step below is wrapped so a broken
    // network, a bad LabConfig, or a JSON encoding surprise never escapes.
    unawaited(_send(error, stack, source));
  }

  static Future<void> _send(
      Object error, StackTrace? stack, String source) async {
    try {
      if (!LabConfig.isConfigured) return;
      final uri = Uri.parse(LabConfig.apiUrl);
      final body = jsonEncode({
        'action': 'crash_report',
        'app_version': LabConfig.appVersion,
        'platform': '$source/${Platform.operatingSystem}',
        'student_id': LabSessionClock.readStudentId() ?? '',
        'full_name': LabSessionClock.readFullName() ?? '',
        'error': error.toString(),
        'stack_trace': stack?.toString() ?? '',
        'secret': LabConfig.sharedSecret,
      });
      // Best-effort: no redirect-following, no retry. Apps Script's POST
      // already executes and appends the row before it answers with its
      // usual 302 (see docs/RELEASES_AND_CI.md) - a crash handler has no
      // business spending extra time/complexity chasing that redirect just
      // to confirm what it doesn't need to act on either way.
      await http
          .post(uri, headers: {'Content-Type': 'application/json'}, body: body)
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // Never let crash reporting itself crash or surface anything.
    }
  }
}
