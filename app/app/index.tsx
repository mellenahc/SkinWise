import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';

const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'skinwise_token';
type Product = {
  id: string;
  name: string;
  brand: string;
  category: string;
  ingredients: string[];
  image_url?: string | null;
  source?: string;
};
type Routine = { id: string; period: string; product: Product };
const pink = '#F6B7C8';
const dark = '#482B3A';
const bg = '#FFF8F9';

class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit, token?: string) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new HttpError(body?.error || `Request failed (${response.status})`, response.status);
  }
  return response.status === 204 ? null : response.json();
}

export default function Home() {
  const [tab, setTab] = useState('Explore');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [skinType, setSkinType] = useState('combination');
  const [concerns, setConcerns] = useState('acne');
  const [profileId, setProfileId] = useState('');
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [period, setPeriod] = useState('AM');
  const [scan, setScan] = useState(false);
  const [permission, askPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registering, setRegistering] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const api = (path: string, init?: RequestInit) => request(path, init, token);
  const loadProfile = async () => {
    try {
      const profile = await api('/profiles/me');
      setProfileId(profile.id);
      setSkinType(profile.skinType);
      setConcerns(profile.concerns.join(', '));
      return profile;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        setProfileId('');
        return null;
      }
      throw e;
    }
  };
  const loadRoutines = async (id = profileId) => {
    if (!id) {
      setRoutines([]);
      return;
    }
    setRoutines(await api(`/profiles/${encodeURIComponent(id)}/routines`));
  };

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      try {
        const savedToken = await AsyncStorage.getItem(TOKEN_KEY);
        if (!savedToken) return;
        try {
          await request('/auth/me', undefined, savedToken);
          if (!active) return;
          setToken(savedToken);
          try {
            const profile = await request('/profiles/me', undefined, savedToken);
            if (!active) return;
            setProfileId(profile.id);
            setSkinType(profile.skinType);
            setConcerns(profile.concerns.join(', '));
          } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 404) throw e;
          }
        } catch (e) {
          if (e instanceof HttpError && e.status === 401) {
            await AsyncStorage.removeItem(TOKEN_KEY);
          } else {
            if (active) {
              setToken(savedToken);
              setError(e instanceof Error ? e.message : 'Could not restore your session.');
            }
          }
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not read your saved session.');
      } finally {
        if (active) setAuthReady(true);
      }
    };
    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request(registering ? '/auth/register' : '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      await AsyncStorage.setItem(TOKEN_KEY, result.token);
      setToken(result.token);
      setEmail(result.user.email);
      setPassword('');
      setError('');
      try {
        const profile = await request('/profiles/me', undefined, result.token);
        setProfileId(profile.id);
        setSkinType(profile.skinType);
        setConcerns(profile.concerns.join(', '));
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 404) throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const loadProducts = async (search = query) => {
    if (!search.trim()) {
      setProducts([]);
      setError('Enter a product or brand name to search.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const data = await api(`/products?q=${encodeURIComponent(search)}`);
      setProducts(data.products || []);
      if (!data.products?.length) {
        setError(data.no_match?.hint
          ? `No results. Try fewer words; remove: ${data.no_match.hint}`
          : 'No matching products found.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Product search failed.');
    } finally {
      setBusy(false);
    }
  };

  const choose = async (product: Product) => {
    setSelected(product);
    setAnalysis(null);
    setScan(false);
    setBusy(true);
    try {
      const data = await api(`/products/${encodeURIComponent(product.id)}/analysis?skinType=${encodeURIComponent(skinType)}&concerns=${encodeURIComponent(concerns)}`);
      setSelected(data.product);
      setAnalysis(data.analysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Product analysis failed.');
    } finally {
      setBusy(false);
    }
  };

  const lookupBarcode = async (barcode: string) => {
    setScan(false);
    setQuery(barcode);
    setBusy(true);
    setError('');
    try {
      const product = await api(`/products/barcode/${encodeURIComponent(barcode)}`);
      setProducts([product]);
      await choose(product);
    } catch (e) {
      setProducts([]);
      setError(e instanceof Error ? e.message : 'Barcode lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    setError('');
    try {
      const data = {
        skinType,
        concerns: concerns.split(',').map((value) => value.trim()).filter(Boolean),
      };
      const profile = await api(profileId ? `/profiles/${encodeURIComponent(profileId)}` : '/profiles', {
        method: profileId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      setProfileId(profile.id);
      setError('Profile saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Profile could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const addRoutine = async () => {
    if (!selected) return;
    try {
      let id = profileId;
      if (!id) {
        const profile = await api('/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skinType,
            concerns: concerns.split(',').map((value) => value.trim()).filter(Boolean),
          }),
        });
        id = profile.id;
        setProfileId(id);
      }
      await api(`/profiles/${encodeURIComponent(id)}/routines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: selected.id, period }),
      });
      await loadRoutines(id);
      setError(`Added to ${period} routine.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add product to routine.');
    }
  };

  const removeRoutine = async (id: string) => {
    try {
      await api(`/routines/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadRoutines();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove routine item.');
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await api('/auth/session', { method: 'DELETE' });
      await AsyncStorage.removeItem(TOKEN_KEY);
      setToken('');
      setProfileId('');
      setRoutines([]);
      setSelected(null);
      setProducts([]);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api('/auth/account', { method: 'DELETE' });
      await AsyncStorage.removeItem(TOKEN_KEY);
      setToken('');
      setProfileId('');
      setRoutines([]);
      setSelected(null);
      setProducts([]);
      setConfirmDelete(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your account.');
    } finally {
      setBusy(false);
    }
  };

  const Button = ({
    label,
    onPress,
    secondary = false,
    disabled = false,
  }: {
    label: string;
    onPress: () => void;
    secondary?: boolean;
    disabled?: boolean;
  }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}
    >
      <Text style={{ fontWeight: '700', color: dark }}>{label}</Text>
    </Pressable>
  );

  if (!authReady) {
    return <View style={[styles.root, styles.center]}><ActivityIndicator color={dark} /></View>;
  }

  if (!token) {
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.logo}>✿ SkinWise</Text>
          <Text style={styles.sub}>Skincare, made clearer.</Text>
          <Text style={styles.title}>{registering ? 'Create your account' : 'Welcome back'}</Text>
          {error ? <Pressable onPress={() => setError('')} style={styles.notice}><Text>{error}  ×</Text></Pressable> : null}
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
          />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder={registering ? 'Password (at least 12 characters)' : 'Password'}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={registering ? 'new-password' : 'current-password'}
            textContentType={registering ? 'newPassword' : 'password'}
          />
          <Button
            label={busy ? 'Please wait...' : registering ? 'Create account' : 'Sign in'}
            onPress={signIn}
            disabled={busy || !email.trim() || !password}
          />
          <Button
            label={registering ? 'Already have an account? Sign in' : 'New to SkinWise? Create an account'}
            onPress={() => {
              setRegistering(!registering);
              setError('');
            }}
            secondary
            disabled={busy}
          />
          <Text style={styles.small}>
            Your account stores your email, skin profile, and routines. Passwords are stored as salted hashes.
            See the privacy notice for details.
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>✿ SkinWise</Text>
        <Text style={styles.sub}>Skincare, made clearer.</Text>
        {error ? <Pressable onPress={() => setError('')} style={styles.notice}><Text>{error}  ×</Text></Pressable> : null}
        {tab === 'Explore' && (
          <>
            <Text style={styles.title}>Discover your skincare</Text>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Search brand and product name (e.g. CeraVe Moisturizing Cream)"
              onSubmitEditing={() => void loadProducts(query)}
            />
            <Button label={busy ? 'Searching...' : 'Search products'} onPress={() => void loadProducts(query)} disabled={busy} />
            <Button
              label="Scan product barcode"
              secondary
              onPress={async () => {
                if (Platform.OS === 'web') {
                  setError('Barcode scanning is available in the iOS and Android apps.');
                  return;
                }
                const result = permission?.granted ? permission : await askPermission();
                if (result.granted) setScan(true);
                else setError('Camera permission is required to scan a barcode.');
              }}
            />
            {scan && (
              <View style={{ height: 260, overflow: 'hidden', borderRadius: 18 }}>
                <CameraView
                  style={{ flex: 1 }}
                  barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
                  onBarcodeScanned={({ data }) => void lookupBarcode(data)}
                />
              </View>
            )}
            {busy && <ActivityIndicator color={dark} />}
            <Text style={styles.heading}>Products</Text>
            {products.map((product) => (
              <Pressable key={product.id} style={styles.card} onPress={() => void choose(product)}>
                <Text style={styles.category}>{product.category.toUpperCase()}</Text>
                <Text style={styles.name}>{product.name}</Text>
                <Text style={styles.muted}>
                  {product.brand} · {product.source || 'Tap for full ingredient list'}
                </Text>
              </Pressable>
            ))}
            {selected && (
              <View style={styles.detail}>
                <Text style={styles.heading}>{selected.name}</Text>
                <Text style={styles.muted}>
                  {selected.ingredients.length ? selected.ingredients.join(' · ') : 'Ingredient list unavailable'}
                </Text>
                {selected.source && <Text style={styles.small}>Product data from Open Beauty Facts (ODbL).</Text>}
                <Text style={styles.heading}>Compatibility rating</Text>
                {analysis && (
                  <View style={[
                    styles.rating,
                    analysis.rating === 'use_with_caution'
                      ? styles.caution
                      : analysis.rating === 'good_match' ? styles.good : styles.unknown,
                  ]}>
                    <Text style={styles.ratingText}>
                      {analysis.rating === 'use_with_caution'
                        ? '⚠ Use With Caution'
                        : analysis.rating === 'good_match' ? '✓ Good Match' : 'ⓘ Insufficient Information'}
                    </Text>
                    <Text style={styles.muted}>{analysis.reasons?.join(' ')}</Text>
                    <Text style={styles.small}>
                      Recognized ingredients: {analysis.coverage?.recognized} of {analysis.coverage?.total}
                    </Text>
                  </View>
                )}
                <Text style={styles.heading}>Ingredient review</Text>
                {analysis?.findings?.map((finding: any, index: number) => (
                  <Text key={index} style={styles.finding}>
                    • {finding.ingredient}: {finding.note}
                    {finding.benefits?.length ? ` Potentially helpful for: ${finding.benefits.join(', ')}` : ''}
                  </Text>
                ))}
                <Text style={styles.small}>{analysis?.disclaimer}</Text>
                <View style={styles.row}>
                  {['AM', 'PM'].map((value) => (
                    <Pressable
                      key={value}
                      onPress={() => setPeriod(value)}
                      style={[styles.chip, period === value && styles.active]}
                    >
                      <Text>{value}</Text>
                    </Pressable>
                  ))}
                </View>
                <Button label={`Add to ${period} routine`} onPress={() => void addRoutine()} />
              </View>
            )}
          </>
        )}
        {tab === 'Profile' && (
          <>
            <Text style={styles.title}>Your skin profile</Text>
            <Text style={styles.muted}>Signed in as {email || 'your account'}.</Text>
            <Text style={styles.muted}>Choose the type that best describes your skin.</Text>
            <View style={styles.row}>
              {['dry', 'oily', 'combination', 'normal', 'sensitive'].map((value) => (
                <Pressable
                  key={value}
                  style={[styles.chip, skinType === value && styles.active]}
                  onPress={() => setSkinType(value)}
                >
                  <Text style={{ textTransform: 'capitalize' }}>{value}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.heading}>Skin concerns</Text>
            <TextInput
              style={styles.input}
              value={concerns}
              onChangeText={setConcerns}
              placeholder="acne, dryness, dark spots"
            />
            <Button label={busy ? 'Saving...' : 'Save profile'} onPress={() => void saveProfile()} disabled={busy} />
            <Text style={styles.small}>
              Your profile and routines are linked to this account. Deleting your account permanently removes them.
              Product searches are sent to The Beauty API; barcode lookups are sent to Open Beauty Facts.
            </Text>
            <Button label={busy ? 'Please wait...' : 'Sign out'} onPress={() => void signOut()} secondary disabled={busy} />
            <Button
              label={confirmDelete ? 'Tap again to permanently delete account' : 'Delete account and data'}
              onPress={() => void deleteAccount()}
              secondary
              disabled={busy}
            />
          </>
        )}
        {tab === 'Routine' && (
          <>
            <Text style={styles.title}>My skincare routine</Text>
            <Button label="Refresh routine" onPress={() => void loadRoutines().catch((e) => setError(e.message))} />
            {['AM', 'PM'].map((value) => (
              <View key={value}>
                <Text style={styles.heading}>{value === 'AM' ? '☀ Morning' : '☾ Evening'}</Text>
                {routines.filter((routine) => routine.period === value).length === 0
                  ? <Text style={styles.muted}>No products added yet.</Text>
                  : routines.filter((routine) => routine.period === value).map((routine) => (
                    <View style={styles.card} key={routine.id}>
                      <Text style={styles.name}>{routine.product.name}</Text>
                      <Pressable onPress={() => void removeRoutine(routine.id)}>
                        <Text style={{ color: '#A34866' }}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
      <View style={styles.nav}>
        {['Explore', 'Routine', 'Profile'].map((value) => (
          <Pressable
            key={value}
            onPress={() => {
              setTab(value);
              if (value === 'Routine') void loadRoutines().catch((e) => setError(e.message));
              if (value === 'Profile') void loadProfile().catch((e) => setError(e.message));
            }}
            style={[styles.navItem, tab === value && styles.navActive]}
          >
            <Text style={{ fontWeight: '700', color: dark }}>{value}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: 22, paddingTop: 55, paddingBottom: 50, maxWidth: 700, width: '100%', alignSelf: 'center', gap: 12 },
  authContent: { padding: 22, paddingTop: 90, paddingBottom: 50, maxWidth: 500, width: '100%', alignSelf: 'center', gap: 14, flexGrow: 1 },
  logo: { fontSize: 30, fontWeight: '900', color: dark },
  sub: { fontSize: 14, color: '#987887' },
  title: { fontSize: 25, fontWeight: '800', color: dark, marginTop: 18 },
  heading: { fontSize: 19, fontWeight: '800', color: dark, marginTop: 12 },
  input: { borderWidth: 1, borderColor: '#E9CCD6', backgroundColor: 'white', borderRadius: 14, padding: 15, fontSize: 15 },
  button: { backgroundColor: pink, padding: 15, borderRadius: 14, alignItems: 'center' },
  secondary: { backgroundColor: '#FCE5ED' },
  disabled: { opacity: 0.55 },
  card: { padding: 18, backgroundColor: 'white', borderRadius: 18, marginTop: 5, borderWidth: 1, borderColor: '#F5E5EA', gap: 5 },
  category: { fontSize: 11, color: '#B36885', fontWeight: '800' },
  name: { fontSize: 17, color: dark, fontWeight: '700' },
  muted: { fontSize: 14, color: '#806D78', lineHeight: 21 },
  detail: { padding: 18, backgroundColor: '#FFF0F4', borderRadius: 18, gap: 10, marginTop: 12 },
  finding: { fontSize: 14, color: dark, lineHeight: 21 },
  small: { fontSize: 12, color: '#806D78', lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 10 },
  chip: { paddingHorizontal: 13, paddingVertical: 11, borderRadius: 20, backgroundColor: 'white', borderWidth: 1, borderColor: '#F0D5DF' },
  active: { backgroundColor: pink },
  nav: { flexDirection: 'row', justifyContent: 'space-around', padding: 14, paddingBottom: 25, backgroundColor: 'white', borderTopWidth: 1, borderTopColor: '#F1DDE5' },
  navItem: { padding: 11, borderRadius: 12 },
  navActive: { backgroundColor: '#FCE5ED' },
  notice: { padding: 12, backgroundColor: '#FFE8C9', borderRadius: 10 },
  rating: { padding: 14, borderRadius: 14, gap: 6 },
  ratingText: { fontWeight: '800', fontSize: 17, color: dark },
  caution: { backgroundColor: '#FFF0D9' },
  good: { backgroundColor: '#E4F4E9' },
  unknown: { backgroundColor: '#EDECF4' },
});
