import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

/// Configuration for the lab API, supporting compile-time constants
/// and persistent local fallback for ease of testing.
class LabConfig {
  static const String _envApiUrl =
      String.fromEnvironment('LAB_API_URL', defaultValue: '');
  static const String _envSharedSecret = String.fromEnvironment(
      'LAB_SHARED_SECRET',
      defaultValue: 'your-secret-key-here');
  static const String _envMachineId =
      String.fromEnvironment('LAB_MACHINE_ID', defaultValue: '');
  static const String _envMachinePassword =
      String.fromEnvironment('LAB_MACHINE_PASSWORD', defaultValue: '');
  // Shown to a student who is stuck (e.g. MSSV not whitelisted, all machines
  // busy for a while). Set at build time; there is no safe generic default
  // ("liên hệ quản trị viên" alone isn't actionable), so this stays empty
  // unless the admin supplies one.
  static const String supportContact =
      String.fromEnvironment('LAB_SUPPORT_CONTACT', defaultValue: '');

  // This build's own version, independent of the RustDesk core version
  // (bind.mainGetVersion() reads Cargo.toml, which this fork doesn't bump
  // per LabDesk-side change). Compared against Config!min_version /
  // latest_version in Code.gs - see handleLogin's force_update gate.
  static const String appVersion =
      String.fromEnvironment('LAB_APP_VERSION', defaultValue: '1.0.0');

  static String? _overrideApiUrl;
  static String? _overrideSharedSecret;
  static String? _overrideMachineId;
  static String? _overrideMachinePassword;

  static String get apiUrl => _overrideApiUrl ?? _envApiUrl;
  static String get sharedSecret => _overrideSharedSecret ?? _envSharedSecret;
  static String get machineRustdeskId => _overrideMachineId ?? _envMachineId;
  static String get machinePassword =>
      _overrideMachinePassword ?? _envMachinePassword;

  /// Whether lab mode is enabled. Defaults to true when compiled into LabDesk.
  static const bool isLabMode =
      bool.fromEnvironment('LAB_MODE', defaultValue: true);

  static bool get isConfigured =>
      apiUrl.trim().isNotEmpty && sharedSecret.trim().isNotEmpty;

  static bool get isCompileTimeLocked =>
      _envApiUrl.isNotEmpty && _envSharedSecret.isNotEmpty;

  static File get _configFile {
    final home = Platform.environment['HOME'] ??
        Platform.environment['USERPROFILE'] ??
        '.';
    return File('$home/.labdesk_config.json');
  }

  // An empty value in the file must not shadow a value baked in at build time,
  // otherwise a stale admin config silently bricks a correctly built client.
  static String? _override(Object? value) {
    final s = value is String ? value.trim() : '';
    return s.isEmpty ? null : s;
  }

  static void loadLocalConfig() {
    try {
      final f = _configFile;
      if (f.existsSync()) {
        final data = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
        _overrideApiUrl = _override(data['api_url']);
        _overrideSharedSecret = _override(data['shared_secret']);
        _overrideMachineId = _override(data['machine_id']);
        _overrideMachinePassword = _override(data['machine_password']);
      }
    } catch (_) {}
  }

  static void saveLocalConfig({
    required String apiUrl,
    required String sharedSecret,
    String? machineId,
    String? machinePassword,
  }) {
    _overrideApiUrl = _override(apiUrl);
    _overrideSharedSecret = _override(sharedSecret);
    if (machineId != null) _overrideMachineId = _override(machineId);
    if (machinePassword != null) {
      _overrideMachinePassword = _override(machinePassword);
    }

    try {
      final f = _configFile;
      f.writeAsStringSync(jsonEncode({
        'api_url': _overrideApiUrl,
        'shared_secret': _overrideSharedSecret,
        'machine_id': _overrideMachineId ?? '',
        'machine_password': _overrideMachinePassword ?? '',
      }));
    } catch (_) {}
  }
}

class LoginResult {
  final bool allowed;
  final String? sessionToken;
  final String? machineId;
  final String? machineName;
  final String? machinePass;
  final String? reason;
  // 'view' when the machine was already occupied and this login was granted
  // as a read-only observer of the existing session instead (Code.gs' view
  // join); anything else (including null, e.g. an error result) means normal
  // control.
  final String? mode;
  // The roster's own name (Students sheet), not what the student typed -
  // Code.gs overrides it whenever the whitelist matches.
  final String? fullName;
  final bool forceUpdate;
  final String? downloadUrl;
  final String? latestVersion;
  final int? queuePosition;
  final String? controllerName;
  final String? controllerStudentId;
  final DateTime? expiresAt;

  bool get isViewOnly => mode == 'view';
  bool get updateAvailable =>
      latestVersion != null &&
      latestVersion!.isNotEmpty &&
      _isVersionOlder(LabConfig.appVersion, latestVersion!);

  // Mirrors Code.gs' compareVersions(): dot-separated numeric segments,
  // unparseable ones count as 0. Keeps the two version checks (force_update
  // server-side, "update available" banner client-side) consistent.
  static bool _isVersionOlder(String a, String b) {
    final pa = a.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    final pb = b.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    for (var i = 0; i < (pa.length > pb.length ? pa.length : pb.length); i++) {
      final va = i < pa.length ? pa[i] : 0;
      final vb = i < pb.length ? pb[i] : 0;
      if (va != vb) return va < vb;
    }
    return false;
  }

  LoginResult({
    required this.allowed,
    this.sessionToken,
    this.machineId,
    this.machineName,
    this.machinePass,
    this.reason,
    this.mode,
    this.fullName,
    this.forceUpdate = false,
    this.downloadUrl,
    this.latestVersion,
    this.queuePosition,
    this.controllerName,
    this.controllerStudentId,
    this.expiresAt,
  });

  factory LoginResult.fromJson(Map<String, dynamic> json) {
    if (json['allowed'] == null && json['error'] != null) {
      return LoginResult.error(
          'Hệ thống phòng lab đang bận hoặc chưa sẵn sàng. Vui lòng liên hệ Quản trị viên.');
    }
    return LoginResult(
      allowed: json['allowed'] == true,
      sessionToken: json['session_token'] as String?,
      machineId: json['machine_id'] as String?,
      machineName: json['machine_name'] as String?,
      machinePass: json['machine_pass'] as String?,
      reason: json['reason'] as String?,
      mode: json['mode'] as String?,
      fullName: json['full_name'] as String?,
      forceUpdate: json['force_update'] == true,
      downloadUrl: json['download_url'] as String?,
      latestVersion: json['latest_version'] as String?,
      queuePosition:
          json['queue_position'] is int ? json['queue_position'] as int : null,
      controllerName: json['controller_name'] as String?,
      controllerStudentId: json['controller_student_id'] as String?,
      expiresAt: (json['expires_at'] is String &&
              (json['expires_at'] as String).isNotEmpty)
          ? DateTime.tryParse(json['expires_at'] as String)
          : null,
    );
  }

  factory LoginResult.error(String message) {
    return LoginResult(allowed: false, reason: message);
  }
}

enum SessionStatus { active, kicked, expired, notFound, error }

class TimeSlot {
  final String date;
  final String timeSlot;
  final String machineId;
  final String machineName;
  final bool available;
  final String? bookedBy;
  final String? bookedByStudentId;

  TimeSlot({
    required this.date,
    required this.timeSlot,
    required this.machineId,
    required this.machineName,
    required this.available,
    this.bookedBy,
    this.bookedByStudentId,
  });

  factory TimeSlot.fromJson(Map<String, dynamic> json) => TimeSlot(
        date: json['date'] as String? ?? '',
        timeSlot: json['time_slot'] as String? ?? '',
        machineId: json['machine_id'] as String? ?? '',
        machineName: json['machine_name'] as String? ?? '',
        available: json['available'] == true,
        bookedBy: json['booked_by'] as String?,
        bookedByStudentId: json['booked_by_student_id'] as String?,
      );
}

// checkAvailability() needs to tell "backend really has no slots configured"
// apart from "the request itself failed" (stale deployment, network error,
// bad secret) - both used to collapse into an empty list and the UI showed
// one misleading hardcoded message for either case.
class AvailabilityResult {
  final List<TimeSlot> slots;
  final String? error;
  AvailabilityResult(this.slots, {this.error});
}

class MyBooking {
  final String date;
  final String timeSlot;
  final String machineId;

  MyBooking(
      {required this.date, required this.timeSlot, required this.machineId});

  factory MyBooking.fromJson(Map<String, dynamic> json) => MyBooking(
        date: json['date'] as String? ?? '',
        timeSlot: json['time_slot'] as String? ?? '',
        machineId: json['machine_id'] as String? ?? '',
      );
}

class LabApiService {
  static final LabApiService instance = LabApiService._();
  LabApiService._();

  final http.Client _client = http.Client();

  /// Sends HTTP request and explicitly follows 301/302/303 redirects (Google Apps Script).
  Future<http.Response> _sendWithRedirect(
    Uri uri, {
    required String method,
    Map<String, String>? headers,
    String? body,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    http.Request request = http.Request(method, uri);
    if (headers != null) request.headers.addAll(headers);
    if (body != null) request.body = body;
    request.followRedirects = false;

    http.StreamedResponse streamed =
        await _client.send(request).timeout(timeout);
    http.Response response = await http.Response.fromStream(streamed);

    int redirects = 0;
    while ([301, 302, 303, 307, 308].contains(response.statusCode) &&
        redirects < 5) {
      redirects++;
      final location = response.headers['location'];
      if (location == null || location.isEmpty) break;
      final redirectUri = Uri.parse(location);
      final getReq = http.Request('GET', redirectUri);
      final nextStreamed = await _client.send(getReq).timeout(timeout);
      response = await http.Response.fromStream(nextStreamed);
    }
    return response;
  }

  /// Pings Google Apps Script Web App to verify connectivity.
  Future<Map<String, dynamic>> testConnection([
    String? testUrl,
    String? testSecret,
  ]) async {
    final url = (testUrl ?? LabConfig.apiUrl).trim();
    final secret = (testSecret ?? LabConfig.sharedSecret).trim();
    if (url.isEmpty || secret.isEmpty) {
      return {
        'success': false,
        'message': 'Vui lòng nhập đầy đủ URL và Shared Secret'
      };
    }
    try {
      final uri = Uri.parse(url).replace(queryParameters: {
        'action': 'ping',
        'secret': secret,
      });
      final response = await _sendWithRedirect(
        uri,
        method: 'GET',
        timeout: const Duration(seconds: 12),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['status'] == 'ok') {
          return {
            'success': true,
            'message':
                data['message'] ?? 'Kết nối tới Google Sheets API thành công!'
          };
        } else if (data['error'] == 'unauthorized') {
          return {
            'success': false,
            'message': 'Sai Secret Key (Unauthorized 403)'
          };
        }
      }
      return {
        'success': false,
        'message': 'Phản hồi HTTP ${response.statusCode}: ${response.body}'
      };
    } catch (e) {
      return {'success': false, 'message': 'Không thể kết nối tới URL: $e'};
    }
  }

  Future<LoginResult> login(String studentId, String fullName) async {
    if (!LabConfig.isConfigured) {
      return LoginResult.error('Chưa cấu hình Google Apps Script API');
    }
    try {
      final response = await _sendWithRedirect(
        Uri.parse(LabConfig.apiUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': 'login',
          'student_id': studentId,
          'full_name': fullName,
          'secret': LabConfig.sharedSecret,
          'client_version': LabConfig.appVersion,
        }),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return LoginResult.fromJson(data);
      }
      return LoginResult.error('Máy chủ phản hồi lỗi (${response.statusCode})');
    } catch (e) {
      // Never interpolate `e`: on a network failure it can embed resolver/host
      // details, and there is nothing a student can act on from that anyway.
      return LoginResult.error(
          'Không thể liên hệ máy chủ đăng nhập. Vui lòng kiểm tra kết nối mạng hoặc liên hệ Quản trị viên.');
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
      final response = await _sendWithRedirect(
        uri,
        method: 'GET',
        timeout: const Duration(seconds: 10),
      );

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
      final response = await _sendWithRedirect(
        Uri.parse(LabConfig.apiUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': 'logout',
          'session_token': sessionToken,
          'secret': LabConfig.sharedSecret,
        }),
        timeout: const Duration(seconds: 10),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data['success'] == true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // Not routed through the login lock server-side (see Code.gs' doPost),
  // so this never queues behind other students' logins.
  Future<bool> sendFeedback(
      String studentId, String fullName, String message) async {
    if (!LabConfig.isConfigured) return false;
    try {
      final response = await _sendWithRedirect(
        Uri.parse(LabConfig.apiUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': 'feedback',
          'student_id': studentId,
          'full_name': fullName,
          'message': message,
          'secret': LabConfig.sharedSecret,
        }),
        timeout: const Duration(seconds: 10),
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        return data['success'] == true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  Future<AvailabilityResult> checkAvailability(String date) async {
    if (!LabConfig.isConfigured) {
      return AvailabilityResult([], error: 'Chưa cấu hình hệ thống.');
    }
    try {
      final uri = Uri.parse(LabConfig.apiUrl).replace(queryParameters: {
        'action': 'check_availability',
        'date': date,
        'secret': LabConfig.sharedSecret,
      });
      final response = await _sendWithRedirect(uri,
          method: 'GET', timeout: const Duration(seconds: 12));
      if (response.statusCode != 200) {
        return AvailabilityResult([],
            error: 'Máy chủ phản hồi lỗi (mã ${response.statusCode}).');
      }
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      // Apps Script's jsonResponse() ignores its status-code argument, so
      // every backend error - including a stale deployment answering
      // {"error":"unknown action"} - arrives as HTTP 200 with an `error`
      // key. Checking the status alone would miss all of them.
      if (data['error'] != null) {
        return AvailabilityResult([], error: 'Lỗi máy chủ: ${data['error']}');
      }
      final slots = data['slots'] as List<dynamic>? ?? [];
      return AvailabilityResult(slots
          .map((s) => TimeSlot.fromJson(s as Map<String, dynamic>))
          .toList());
    } catch (e) {
      return AvailabilityResult([], error: 'Không kết nối được máy chủ: $e');
    }
  }

  Future<List<MyBooking>> myBookings(String studentId) async {
    if (!LabConfig.isConfigured || studentId.isEmpty) return [];
    try {
      final uri = Uri.parse(LabConfig.apiUrl).replace(queryParameters: {
        'action': 'my_bookings',
        'student_id': studentId,
        'secret': LabConfig.sharedSecret,
      });
      final response = await _sendWithRedirect(uri,
          method: 'GET', timeout: const Duration(seconds: 12));
      if (response.statusCode != 200) return [];
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final bookings = data['bookings'] as List<dynamic>? ?? [];
      return bookings
          .map((b) => MyBooking.fromJson(b as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<String?> book(String studentId, String fullName, String date,
      String timeSlot, String machineId) async {
    if (!LabConfig.isConfigured) return 'Chưa cấu hình hệ thống.';
    try {
      final response = await _sendWithRedirect(
        Uri.parse(LabConfig.apiUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': 'book',
          'student_id': studentId,
          'full_name': fullName,
          'date': date,
          'time_slot': timeSlot,
          'machine_id': machineId,
          'secret': LabConfig.sharedSecret,
        }),
        timeout: const Duration(seconds: 15),
      );
      if (response.statusCode != 200) return 'Máy chủ phản hồi lỗi.';
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['success'] == true) return null;
      return data['reason'] as String? ?? 'Đặt lịch không thành công.';
    } catch (_) {
      return 'Lỗi mạng, vui lòng thử lại.';
    }
  }

  Future<bool> cancelBooking(
      String studentId, String date, String timeSlot, String machineId) async {
    if (!LabConfig.isConfigured) return false;
    try {
      final response = await _sendWithRedirect(
        Uri.parse(LabConfig.apiUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'action': 'cancel_booking',
          'student_id': studentId,
          'date': date,
          'time_slot': timeSlot,
          'machine_id': machineId,
          'secret': LabConfig.sharedSecret,
        }),
        timeout: const Duration(seconds: 12),
      );
      if (response.statusCode != 200) return false;
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return data['success'] == true;
    } catch (_) {
      return false;
    }
  }
}
