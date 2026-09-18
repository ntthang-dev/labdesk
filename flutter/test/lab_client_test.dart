import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';
import 'package:flutter_hbb/desktop/pages/lab_session_clock.dart';

void main() {
  // saveLocalConfig writes to the real ~/.labdesk_config.json; leaving test
  // values behind would override a locally built client.
  tearDownAll(() {
    final home = Platform.environment['HOME'] ??
        Platform.environment['USERPROFILE'] ??
        '.';
    final f = File('$home/.labdesk_config.json');
    if (f.existsSync()) f.deleteSync();
  });

  group('LabConfig Tests', () {
    test('Defaults and compile-time constants are handled safely', () {
      expect(LabConfig.isLabMode, isTrue);
      expect(LabConfig.machineRustdeskId, isEmpty);
      expect(LabConfig.machinePassword, isEmpty);
      expect(LabConfig.sharedSecret, equals('your-secret-key-here'));
    });

    test('saveLocalConfig and loadLocalConfig persist and override properties', () {
      LabConfig.saveLocalConfig(
        apiUrl: 'https://script.google.com/macros/s/test-url/exec',
        sharedSecret: 'test-secret-123',
        machineId: '100.83.83.70',
        machinePassword: 'test-lab-pass',
      );

      expect(LabConfig.apiUrl, equals('https://script.google.com/macros/s/test-url/exec'));
      expect(LabConfig.sharedSecret, equals('test-secret-123'));
      expect(LabConfig.machineRustdeskId, equals('100.83.83.70'));
      expect(LabConfig.machinePassword, equals('test-lab-pass'));
      expect(LabConfig.isConfigured, isTrue);
    });
  });

  group('LoginResult Parsing Tests', () {
    test('Parses successful login result with all fields', () {
      final json = {
        'allowed': true,
        'session_token': 'sess-uuid-1234',
        'machine_id': '100.83.83.70',
        'machine_name': 'PC Lab 01',
        'machine_pass': 'secret-pass-99',
      };

      final result = LoginResult.fromJson(json);
      expect(result.allowed, isTrue);
      expect(result.sessionToken, equals('sess-uuid-1234'));
      expect(result.machineId, equals('100.83.83.70'));
      expect(result.machineName, equals('PC Lab 01'));
      expect(result.machinePass, equals('secret-pass-99'));
      expect(result.reason, isNull);
    });

    test('Parses rejected login result with reason', () {
      final json = {
        'allowed': false,
        'reason': 'Student ID not recognized',
      };

      final result = LoginResult.fromJson(json);
      expect(result.allowed, isFalse);
      expect(result.reason, equals('Student ID not recognized'));
      expect(result.sessionToken, isNull);
    });

    test('Creates error result correctly', () {
      final result = LoginResult.error('Network timeout');
      expect(result.allowed, isFalse);
      expect(result.reason, equals('Network timeout'));
      expect(result.sessionToken, isNull);
    });
  });

  group('SessionStatus Enum Tests', () {
    test('Status mapping from Apps Script values', () {
      SessionStatus parseStatus(String statusStr) {
        switch (statusStr) {
          case 'active':
            return SessionStatus.active;
          case 'kicked':
            return SessionStatus.kicked;
          case 'expired':
            return SessionStatus.expired;
          case 'not_found':
            return SessionStatus.notFound;
          default:
            return SessionStatus.error;
        }
      }

      expect(parseStatus('active'), equals(SessionStatus.active));
      expect(parseStatus('kicked'), equals(SessionStatus.kicked));
      expect(parseStatus('expired'), equals(SessionStatus.expired));
      expect(parseStatus('not_found'), equals(SessionStatus.notFound));
      expect(parseStatus('unknown_value'), equals(SessionStatus.error));
    });
  });

  group('LabApiService Connection Tests', () {
    test('testConnection fails gracefully when URL or secret is empty', () async {
      final res = await LabApiService.instance.testConnection('', '');
      expect(res['success'], isFalse);
      expect(res['message'], contains('Vui lòng nhập đầy đủ'));
    });

    test('login returns error when not configured', () async {
      // Temporarily clear configuration
      LabConfig.saveLocalConfig(apiUrl: '', sharedSecret: '');
      final res = await LabApiService.instance.login('20210001', 'Nguyen Van A');
      expect(res.allowed, isFalse);
      expect(res.reason, contains('Chưa cấu hình'));
    });
  });

  group('LabSessionClock Tests', () {
    // The remote desktop window is a separate isolate and reads this file to
    // draw its countdown, so a silent regression here means a student sees no
    // timer at all - with nothing failing anywhere else to reveal it.
    tearDown(() => LabSessionClock.write(null));

    test('round-trips an expiry to the second', () {
      final expires = DateTime.now().add(const Duration(minutes: 42));
      LabSessionClock.write(expires);
      final read = LabSessionClock.read();
      expect(read, isNotNull);
      expect(read!.difference(expires).inSeconds.abs(), lessThanOrEqualTo(1));
    });

    test('write(null) clears a previous session', () {
      LabSessionClock.write(DateTime.now().add(const Duration(minutes: 5)));
      expect(LabSessionClock.read(), isNotNull);
      LabSessionClock.write(null);
      expect(LabSessionClock.read(), isNull);
    });

    test('unlimited session (no expiry) reads back as null', () {
      LabSessionClock.write(null);
      expect(LabSessionClock.read(), isNull);
    });

    test('a corrupt file reads as null instead of throwing', () {
      final home = Platform.environment['HOME'] ??
          Platform.environment['USERPROFILE'] ??
          '.';
      File('$home/.labdesk_session.json').writeAsStringSync('not json at all');
      expect(LabSessionClock.read(), isNull);
    });
  });
}
