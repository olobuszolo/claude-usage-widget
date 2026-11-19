import { ExtensionStorage } from '@bacons/apple-targets';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

// Must match Config.appGroup in targets/widget/widgets.swift.
const storage = new ExtensionStorage('group.com.aleksanderbuszek.claudeusage');

type Backend = { url: string; key: string };

function loadBackend(): Backend | null {
  const url = storage.get('supabaseURL');
  const key = storage.get('publishableKey');
  return url && key ? { url, key } : null;
}

// The pairing QR code (shown by the Mac setup tool) holds {"url": "...", "key": "..."}.
function parsePairing(data: string): Backend | null {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed?.url === 'string' && typeof parsed?.key === 'string') {
      return { url: parsed.url.trim(), key: parsed.key.trim() };
    }
  } catch {}
  return null;
}

// Checks the credentials against the read-only RPC before saving them.
async function verify({ url, key }: Backend): Promise<string | null> {
  if (!/^https:\/\//.test(url)) return 'URL must start with https://';
  try {
    const base = url.replace(/\/+$/, '');
    const response = await fetch(`${base}/rest/v1/rpc/latest_usage`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (response.ok) return null;
    return response.status === 401 || response.status === 403
      ? 'Supabase rejected the key'
      : `Supabase returned HTTP ${response.status} (is the schema installed?)`;
  } catch {
    return 'Could not reach the Supabase URL';
  }
}

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(loadBackend);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [permission, requestPermission] = useCameraPermissions();

  async function save(candidate: Backend) {
    setBusy(true);
    setError(null);
    const problem = await verify(candidate);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    storage.set('supabaseURL', candidate.url);
    storage.set('publishableKey', candidate.key);
    ExtensionStorage.reloadWidget();
    setBackend(candidate);
    setScanning(false);
    setUrl('');
    setKey('');
  }

  function forget() {
    storage.remove('supabaseURL');
    storage.remove('publishableKey');
    ExtensionStorage.reloadWidget();
    setBackend(null);
  }

  async function onScanned(data: string) {
    setScanning(false);
    const pairing = parsePairing(data);
    if (!pairing) {
      setError('This QR code is not a Claude Usage pairing code');
      return;
    }
    await save(pairing);
  }

  if (scanning) {
    if (!permission?.granted) {
      return (
        <View style={styles.center}>
          <Text style={styles.body}>Camera access is needed to scan the pairing QR code.</Text>
          <Button title="Allow camera" onPress={requestPermission} />
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      );
    }
    return (
      <View style={styles.flex}>
        <CameraView
          style={styles.flex}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
        />
        <View style={styles.scanFooter}>
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Claude Usage</Text>

        {backend ? (
          <View style={styles.section}>
            <Text style={styles.body}>Connected to</Text>
            <Text style={styles.mono}>{backend.url}</Text>
            <Text style={styles.hint}>The widget now reads usage from this Supabase project.</Text>
            <Button title="Disconnect" color="#c00" onPress={forget} />
          </View>
        ) : (
          <Text style={styles.body}>
            Not connected. Run the setup tool on your Mac and scan the QR code it shows, or enter the
            details manually.
          </Text>
        )}

        <View style={styles.section}>
          <Button
            title={backend ? 'Scan a new QR code' : 'Scan QR code'}
            disabled={busy}
            onPress={() => {
              setError(null);
              setScanning(true);
            }}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Supabase URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://xxxx.supabase.co"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.label}>Publishable key</Text>
          <TextInput
            style={styles.input}
            value={key}
            onChangeText={setKey}
            placeholder="sb_publishable_..."
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            title="Save"
            disabled={busy || !url.trim() || !key.trim()}
            onPress={() => save({ url: url.trim(), key: key.trim() })}
          />
        </View>

        {busy && <Text style={styles.hint}>Checking connection…</Text>}
        {error && <Text style={styles.error}>{error}</Text>}
        <StatusBar style="auto" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 24, paddingTop: 80, gap: 20, backgroundColor: '#fff', flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 28, fontWeight: '700' },
  section: { gap: 8 },
  body: { fontSize: 16 },
  hint: { fontSize: 13, color: '#666' },
  mono: { fontFamily: 'Menlo', fontSize: 13 },
  label: { fontSize: 13, color: '#666' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, fontSize: 15 },
  error: { color: '#c00', fontSize: 14 },
  scanFooter: { position: 'absolute', bottom: 48, alignSelf: 'center', backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 16 },
});
