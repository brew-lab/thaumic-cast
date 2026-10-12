import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getAutostartEnabled,
  setAutostartEnabled,
  getManualSpeakerIps,
  removeManualSpeakerIp,
  clearSpeakerNotices,
  setShowDiagnostics,
  showDiagnostics,
  getSpeakerMonitor,
  setSpeakerMonitor,
  getHeadStart,
  setHeadStart,
  getDriftCompensation,
  setDriftCompensation,
  type DriftCompensationSetting,
  type HeadStartSetting,
  type SpeakerMonitorSetting,
} from '../state/store';
import { headStartOptions } from '../lib/speaker-notices';
import { driftModeForToggle, driftToggleState } from '../lib/drift-setting';
import { speakerMonitorOverrideKey } from '../lib/speaker-monitor-setting';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import {
  AddressField,
  Button,
  Cluster,
  DescriptionList,
  PageHeader,
  SegmentedControl,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  type AddressResult,
} from '@thaumic-cast/ui';
import { PROTOCOL_VERSION } from '@thaumic-cast/protocol';
import { createLogger, GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import i18n, { resources, SupportedLocale } from '../lib/i18n';
import { hasLanguageChoice } from '../lib/language-choice';
import { type ThemeMode, getTheme, saveTheme, applyTheme } from '../lib/theme';
import { addManualSpeaker, getSpeakerErrorMessage } from '../lib/manual-speaker';

const log = createLogger('Settings');

/** Language display names */
const LANGUAGE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
};

/**
 * Settings page.
 *
 * Allows users to configure app preferences:
 * - Autostart on login
 * - Language selection, once there is more than one language
 * - Theme (auto/light/dark)
 * - Speaker monitoring, the speaker head start, clock drift correction, Show
 *   diagnostics and speakers added by IP address
 * @returns The rendered Settings page
 */
export function Settings() {
  const { t } = useTranslation();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [speakerMonitor, setSpeakerMonitorState] = useState<SpeakerMonitorSetting | null>(null);
  const [headStart, setHeadStartState] = useState<HeadStartSetting | null>(null);
  const [drift, setDriftState] = useState<DriftCompensationSetting | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState<SupportedLocale>(
    i18n.language as SupportedLocale,
  );
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>(getTheme);

  // Manual speaker state
  const [manualIps, setManualIps] = useState<string[]>([]);
  const [removingIp, setRemovingIp] = useState<string | null>(null);

  // App version for the About section
  const [appVersion, setAppVersion] = useState<string>('');

  const [speakerIp, setSpeakerIp] = useState('');

  const handleAddSpeaker = useCallback(
    async (ip: string): Promise<AddressResult> => {
      const outcome = await addManualSpeaker(ip);
      if (!outcome.ok) return { ok: false, error: getSpeakerErrorMessage(outcome.code, t) };
      // Prevent duplicates in UI (backend also prevents, but avoid UI flicker)
      setManualIps((prev) => (prev.includes(outcome.ip) ? prev : [...prev, outcome.ip]));
      return { ok: true, said: t('settings.manual_added', { address: outcome.ip }) };
    },
    [t],
  );

  useEffect(() => {
    getAutostartEnabled()
      .then(setAutostart)
      .catch(() => setAutostart(false));

    getManualSpeakerIps()
      .then(setManualIps)
      .catch(() => setManualIps([]));

    getSpeakerMonitor()
      .then(setSpeakerMonitorState)
      .catch((error) => log.error('Failed to read speaker monitoring setting:', error));

    getHeadStart()
      .then(setHeadStartState)
      .catch((error) => log.error('Failed to read the speaker head start setting:', error));

    getDriftCompensation()
      .then(setDriftState)
      .catch((error) => log.error('Failed to read the drift correction setting:', error));

    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''));
  }, []);

  const handleCheckForUpdates = useCallback(() => {
    open(GITHUB_RELEASES_URL);
  }, []);

  const handleRemoveSpeaker = useCallback(async (ip: string) => {
    setRemovingIp(ip);
    try {
      await removeManualSpeakerIp(ip);
      setManualIps((prev) => prev.filter((i) => i !== ip));
      // Backend automatically triggers topology refresh; Speakers view updates via event listener
    } catch (error) {
      log.error('Failed to remove speaker:', error);
      // Refresh from backend to restore consistent state
      getManualSpeakerIps()
        .then(setManualIps)
        .catch(() => {});
    } finally {
      setRemovingIp(null);
    }
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    try {
      await setAutostartEnabled(enabled);
      setAutostart(enabled);
    } catch (error) {
      log.error('Failed to set autostart:', error);
    }
  };

  const handleSpeakerMonitorChange = async (enabled: boolean) => {
    try {
      const setting = await setSpeakerMonitor(enabled);
      setSpeakerMonitorState(setting);
      // No more reports will replace the notices showing, so drop them now.
      if (!(setting.envOverride ?? setting.enabled)) clearSpeakerNotices();
    } catch (error) {
      log.error('Failed to set speaker monitoring:', error);
      getSpeakerMonitor()
        .then(setSpeakerMonitorState)
        .catch(() => {});
    }
  };

  const handleHeadStartChange = async (ms: number) => {
    try {
      setHeadStartState(await setHeadStart(ms));
    } catch (error) {
      log.error('Failed to set the speaker head start:', error);
      // Re-read so the select stops showing a value that was not saved.
      getHeadStart()
        .then(setHeadStartState)
        .catch(() => {});
    }
  };

  const handleDriftChange = async (checked: boolean) => {
    try {
      setDriftState(await setDriftCompensation(driftModeForToggle(checked)));
    } catch (error) {
      log.error('Failed to set drift correction:', error);
      // Re-read so the toggle stops showing a value that was not saved.
      getDriftCompensation()
        .then(setDriftState)
        .catch(() => {});
    }
  };

  const handleLanguageChange = (locale: SupportedLocale) => {
    i18n.changeLanguage(locale);
    setCurrentLanguage(locale);
  };

  const handleThemeChange = (theme: ThemeMode) => {
    applyTheme(theme);
    saveTheme(theme);
    setCurrentTheme(theme);
  };

  const availableLanguages = Object.keys(resources) as SupportedLocale[];
  const headStartMs = headStart?.envOverride ?? headStart?.ms ?? null;
  const monitorOn = speakerMonitor ? (speakerMonitor.envOverride ?? speakerMonitor.enabled) : null;
  const monitorOverrideKey = speakerMonitorOverrideKey(speakerMonitor);
  const driftToggle = driftToggleState(drift, monitorOn);

  return (
    <>
      <PageHeader title={t('nav.settings')} />

      <SettingsSection id="startup" title={t('settings.startup')}>
        <Switch
          label={t('settings.autostart')}
          description={t('settings.autostart_description')}
          checked={autostart ?? false}
          onChange={handleAutostartChange}
          disabled={autostart === null}
        />
      </SettingsSection>

      {/* Language Section: shown once there is a second language to pick */}
      {hasLanguageChoice(availableLanguages) && (
        <SettingsSection id="language" title={t('settings.language')}>
          <SettingsRow
            label={t('settings.display_language')}
            control={
              <Select
                label={t('settings.display_language')}
                hideLabel
                value={currentLanguage}
                options={availableLanguages.map((locale) => ({
                  value: locale,
                  label: LANGUAGE_NAMES[locale],
                }))}
                onChange={handleLanguageChange}
              />
            }
          />
        </SettingsSection>
      )}

      <SettingsSection id="appearance" title={t('settings.appearance')}>
        <SettingsRow
          label={t('settings.theme')}
          controlWidth="wide"
          help={currentTheme === 'auto' ? t('settings.theme_auto_desc') : undefined}
          control={(a11y) => (
            <SegmentedControl
              label={t('settings.theme')}
              hideLabel
              value={currentTheme}
              onChange={handleThemeChange}
              aria-describedby={a11y['aria-describedby']}
              options={[
                { value: 'auto', label: t('settings.theme_auto'), glyph: 'contrast' },
                { value: 'light', label: t('settings.theme_light'), glyph: 'sun' },
                { value: 'dark', label: t('settings.theme_dark'), glyph: 'moon' },
              ]}
            />
          )}
        />
      </SettingsSection>

      <SettingsSection id="speakers" title={t('settings.speakers')}>
        <Switch
          label={t('settings.speaker_monitor')}
          description={t('settings.speaker_monitor_description')}
          note={monitorOverrideKey !== null ? t(monitorOverrideKey) : undefined}
          checked={speakerMonitor?.envOverride ?? speakerMonitor?.enabled ?? false}
          onChange={handleSpeakerMonitorChange}
          disabled={speakerMonitor === null || speakerMonitor.envOverride !== null}
        />

        <SettingsRow
          label={t('settings.head_start')}
          help={t('settings.head_start_description')}
          locked={headStart?.envOverride != null}
          note={
            headStart?.envOverride != null
              ? headStart.envOverride === 0
                ? t('settings.head_start_env_off')
                : t('settings.head_start_env', { value: headStart.envOverride })
              : undefined
          }
          control={(a11y) =>
            headStartMs !== null && (
              <Select
                id="settings-head-start"
                label={t('settings.head_start')}
                hideLabel
                value={headStartMs}
                options={headStartOptions(headStartMs).map(({ ms, custom }) => ({
                  value: ms,
                  label: custom
                    ? t('settings.head_start_custom', { value: ms })
                    : ms === 0
                      ? t('settings.head_start_off')
                      : t('settings.head_start_ms', { value: ms }),
                }))}
                onChange={handleHeadStartChange}
                disabled={headStart === null || headStart.envOverride !== null}
                aria-describedby={a11y['aria-describedby']}
              />
            )
          }
        />

        <Switch
          label={t('settings.drift')}
          description={t('settings.drift_description')}
          note={driftToggle.hint ? t(driftToggle.hint.key) : undefined}
          checked={driftToggle.checked}
          onChange={handleDriftChange}
          disabled={driftToggle.disabled}
        />

        <Switch
          label={t('settings.diagnostics')}
          description={t('settings.diagnostics_description')}
          note={monitorOn === false ? t('settings.diagnostics_needs_monitor') : undefined}
          checked={showDiagnostics.value && monitorOn !== false}
          onChange={setShowDiagnostics}
          disabled={monitorOn !== true}
        />

        <AddressField
          kind="speaker"
          id="settings-speaker-ip"
          label={t('settings.add_speaker')}
          placeholder={t('onboarding.speakers.manual_ip_placeholder')}
          value={speakerIp}
          onChange={setSpeakerIp}
          onTest={handleAddSpeaker}
          action={{
            idle: t('onboarding.speakers.manual_add'),
            busy: t('onboarding.speakers.manual_testing'),
            failed: t('settings.try_again'),
          }}
          list={manualIps}
          listLabel={t('settings.manual_speakers')}
          removeLabel={(address) => t('settings.remove_speaker_address', { address })}
          onRemove={handleRemoveSpeaker}
          removing={removingIp !== null}
        />
      </SettingsSection>

      <SettingsSection id="about" title={t('settings.about')}>
        <DescriptionList
          kind="readout"
          rows={[
            {
              key: 'app',
              term: t('settings.about_app'),
              value: (
                <>
                  {appVersion ? t('settings.about_version', { version: appVersion }) : '—'}
                  <br />
                  {t('settings.about_protocol', { version: PROTOCOL_VERSION })}
                </>
              ),
            },
          ]}
        />
        <Cluster>
          <Button
            kind="link"
            icon="external"
            onClick={handleCheckForUpdates}
            aria-describedby="settings-updates-hint"
          >
            {t('settings.check_for_updates')}
          </Button>
        </Cluster>
        <p id="settings-updates-hint">{t('settings.check_for_updates_description')}</p>
      </SettingsSection>
    </>
  );
}
