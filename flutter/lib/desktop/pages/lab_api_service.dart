import 'dart:convert';
import 'package:http/http.dart' as http;

/// Configuration for the lab API, read from compile-time constants.
class LabConfig {
  /// Apps Script Web App URL. Set via --dart-define=LAB_API_URL=...
  static const String apiUrl =
      String.fromEnvironment('LAB_API_URL', defaultValue: '');

  /// Shared secret between client and Apps Script.
  static const String sharedSecret =
      String.fromEnvironment('LAB_SHARED_SECRET', defaultValue: '');

  /// RustDesk ID of the lab machine (for single-machine setup).
  static const String machineRustdeskId =
      String.fromEnvironment('LAB_MACHINE_ID', defaultValue: '');

  /// Permanent password of the lab machine.
  static const String machinePassword =
      String.fromEnvironment('LAB_MACHINE_PASSWORD', defaultValue: '');

  /// Whether lab mode is enabled.
  static const bool isLabMode =
      bool.fromEnvironment('LAB_MODE', defaultValue: false);

  static bool get isConfigured =>
      apiUrl.isNotEmpty && sharedSecret.isNotEmpty;
}

class LoginResult {
  final bool allowed;
  final String? sessionToken;
  final String? machineId;
  final String? machineName;
  final String? machinePass;
  final String? reason;

  LoginResult({
    required this.allowed,
    this.sessionToken,
    this.machineId,
    this.machineName,
    this.machinePass,
    this.reason,
  });

  factory LoginResult.fromJson(Map<String, dynamic> json) {
    return LoginResult(
      allowed: json['allowed'] == true,
      sessionToken: json['session_token'] as String?,
      machineId: json['machine_id'] as String?,
      machineName: json['machine_name'] as String?,
      machinePass: json['machine_pass'] as String?,
      reason: json['reason'] as String?,
    );
  }

  factory LoginResult.error(String message) {
    return LoginResult(allowed: false, reason: message);
  }
}

enum SessionStatus { active, kicked, expired, notFound, error }

class LabApiService {
  static final LabApiService instance = LabApiService._();
  LabApiService._();

  final http.Client _client = http.Client();

  Future<LoginResult> login(String studentId, String fullName) async {
    if (!LabConfig.isConfigured) {
      return LoginResult.error('Lab API not configured');
    }
    try {
      final response = await _client
          .post(
            Uri.parse(LabConfig.apiUrl),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'action': 'login',
              'student_id': studentId,
              'full_name': fullName,
              'secret': LabConfig.sharedSecret,
            }),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 200 || response.statusCode == 302) {
        // Apps Script Web App may return 302 redirect; http package follows it.
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return LoginResult.fromJson(data);
      }
      return LoginResult.error(
          'Server error (${response.statusCode})');
    } catch (e) {
      return LoginResult.error('Network error: $e');
    }
  }

  Future<SessionStatus> checkStatus(String sessionToken) async {
    if (!LabConfig.isConfigured) return SessionStatus.error;
    try {
      final uri = Uri.parse(LabConfig.apiUrl).replace(queryParameters: {
        'action': 'status',
        'token': sessionToken,
        'secret': LabConfig.sharedSecret,
      });
      final response =
          await _client.get(uri).timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        switch (data['status']) {
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
      return SessionStatus.error;
    } catch (_) {
      return SessionStatus.error;
    }
  }

  Future<bool> logout(String sessionToken) async {
    if (!LabConfig.isConfigured) return false;
    try {
      final response = await _client
          .post(
            Uri.parse(LabConfig.apiUrl),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'action': 'logout',
              'session_token': sessionToken,
              'secret': LabConfig.sharedSecret,
            }),
          )
          .timeout(const Duration(seconds: 10));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data['success'] == true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }
}
