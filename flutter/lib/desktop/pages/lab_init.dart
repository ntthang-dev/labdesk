import 'package:flutter_hbb/desktop/pages/lab_api_service.dart';
import 'package:flutter_hbb/models/platform_model.dart';

/// Compile-time server config for lab mode.
/// Set via --dart-define flags during build.
class LabServerConfig {
  static const String rendezvousServer =
      String.fromEnvironment('LAB_RENDEZVOUS_SERVER', defaultValue: '');
  static const String publicKey =
      String.fromEnvironment('LAB_RS_PUB_KEY', defaultValue: '');
  static const String relayServer =
      String.fromEnvironment('LAB_RELAY_SERVER', defaultValue: '');
}

Future<void> initLabMode() async {
  LabConfig.loadLocalConfig();
  if (!LabConfig.isLabMode) return;

  // Set server config if provided via build-time env vars
  if (LabServerConfig.rendezvousServer.isNotEmpty) {
    await bind.mainSetOption(
        key: 'custom-rendezvous-server',
        value: LabServerConfig.rendezvousServer);
  }
  if (LabServerConfig.publicKey.isNotEmpty) {
    await bind.mainSetOption(
        key: 'key', value: LabServerConfig.publicKey);
  }
  if (LabServerConfig.relayServer.isNotEmpty) {
    await bind.mainSetOption(
        key: 'relay-server', value: LabServerConfig.relayServer);
  }

  // Lock down settings so students cannot view or modify configurations
  await bind.mainSetOption(key: 'hide-general-settings', value: 'Y');
  await bind.mainSetOption(key: 'hide-security-settings', value: 'Y');
  await bind.mainSetOption(key: 'hide-network-settings', value: 'Y');
  await bind.mainSetOption(key: 'hide-server-settings', value: 'Y');
  await bind.mainSetOption(key: 'hide-proxy-settings', value: 'Y');
  await bind.mainSetOption(key: 'disable-change-permanent-password', value: 'Y');
  await bind.mainSetOption(key: 'disable-change-id', value: 'Y');
  await bind.mainSetOption(key: 'allow-deep-link-server-settings', value: 'N');
}
