import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { AddressField } from '../../src/AddressField';
import { Badge } from '../../src/Badge';
import { Button } from '../../src/Button';
import { Card } from '../../src/Card';
import { Chip } from '../../src/Chip';
import { Cluster } from '../../src/Cluster';
import { CopyField } from '../../src/CopyField';
import { DescriptionList } from '../../src/DescriptionList';
import { Disclosure } from '../../src/Disclosure';
import { IconButton } from '../../src/IconButton';
import { Notice } from '../../src/Notice';
import { PageHeader } from '../../src/PageHeader';
import { SegmentedControl } from '../../src/SegmentedControl';
import { Select } from '../../src/Select';
import { SettingsRow } from '../../src/SettingsRow';
import { Slider } from '../../src/Slider';
import { Switch } from '../../src/Switch';
import { TextInput } from '../../src/TextInput';

const noop = (): void => {};

const COPY = {
  done: 'Copied',
  refusedNote: 'The clipboard said no. Here it is, selected, to copy by hand.',
  unavailableNote: "This computer's address isn't known yet. Try again in a moment.",
};

/**
 * The size rule's atoms at sm and md on a window, each with its hit area (F-size): Button
 * and IconButton reach 44 by their ::after, TextInput and Select by their native element.
 * @returns The atoms
 */
function Atoms(): JSX.Element {
  const [text, setText] = useState('192.168.1.47');
  return (
    <div class="size-mock" data-mock="atoms">
      <p class="label">Window: sm is 32, md is 44; every target reaches 44</p>
      <Cluster>
        <Button>Restart</Button>
        <Button kind="outline">Disconnect</Button>
        <Button size="md" kind="filled" icon="stop" danger>
          Stop all casts
        </Button>
      </Cluster>
      <Cluster>
        <IconButton glyph="x" size="sm" label="Dismiss" />
        <IconButton glyph="volume" label="Mute Kitchen" />
        <IconButton glyph="settings" kind="tonal" label="Settings" />
      </Cluster>
      <div class="size-fields">
        <TextInput kind="address" aria-label="Speaker address" value={text} onInput={setText} />
        <Select
          label="Speaker head start"
          hideLabel
          value={250}
          options={[
            { value: 0, label: 'Off' },
            { value: 250, label: '250 ms' },
            { value: 500, label: '500 ms' },
          ]}
          onChange={noop}
        />
      </div>
      <Disclosure label="Advanced" summary="Smoothing 200 ms">
        <p class="label">The fold's body.</p>
      </Disclosure>
    </div>
  );
}

/**
 * A mock of the desktop Server view at 32: the Address as text with a quiet Copy beside it,
 * and the actions as rows with 32 Buttons.
 * @returns The view
 */
function ServerMock(): JSX.Element {
  return (
    <div class="size-mock stack" data-mock="server">
      <Card title="Running" level={3}>
        <DescriptionList
          kind="stat"
          rows={[
            {
              key: 'address',
              term: 'Address',
              value: <CopyField value="192.168.1.20:49400" action="Copy address" {...COPY} />,
            },
            { key: 'clients', term: 'Extension connections', value: 2, count: true },
            { key: 'streams', term: 'Casts running', value: 1, count: true },
          ]}
        />
      </Card>
      <Card title="Actions" level={3}>
        <SettingsRow
          label="Restart Thaumic Cast"
          help="Closes Thaumic Cast and opens it again, which ends every cast on the way."
          controlWidth="action"
          control={<Button icon="refresh">Restart</Button>}
        />
        <SettingsRow
          label="Disconnect extensions"
          help="Hangs up on every extension, which ends every cast."
          controlWidth="action"
          control={<Button kind="outline">Disconnect</Button>}
        />
        <SettingsRow
          label="Stop all casts"
          help="Stops every cast, including any started from another computer."
          controlWidth="action"
          control={
            <Button kind="filled" danger icon="stop">
              Stop
            </Button>
          }
        />
      </Card>
    </div>
  );
}

/**
 * A mock of desktop Settings › Speakers at 32: one rhythm for the Select, the address field,
 * the Chips and the Theme track.
 * @returns The view
 */
function SettingsMock(): JSX.Element {
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [ip, setIp] = useState('');
  const [monitor, setMonitor] = useState(true);
  return (
    <div class="size-mock stack" data-mock="settings">
      <Card title="Appearance" level={3}>
        <SettingsRow
          label="Theme"
          controlWidth="wide"
          help="Light or dark, whichever the system is set to."
          control={(a11y) => (
            <SegmentedControl
              label="Theme"
              hideLabel
              value={theme}
              onChange={setTheme}
              aria-describedby={a11y['aria-describedby']}
              options={[
                { value: 'auto', label: 'Auto', glyph: 'contrast' },
                { value: 'light', label: 'Light', glyph: 'sun' },
                { value: 'dark', label: 'Dark', glyph: 'moon' },
              ]}
            />
          )}
        />
      </Card>
      <Card title="Speakers" level={3}>
        <Switch
          label="Speaker monitoring"
          description="Works out how much audio each speaker has in reserve."
          checked={monitor}
          onChange={setMonitor}
        />
        <SettingsRow
          label="Speaker head start"
          help="Audio handed to each speaker in advance."
          control={(a11y) => (
            <Select
              label="Speaker head start"
              hideLabel
              value={250}
              options={[
                { value: 0, label: 'Off' },
                { value: 250, label: '250 ms' },
              ]}
              onChange={noop}
              aria-describedby={a11y['aria-describedby']}
            />
          )}
        />
        <AddressField
          kind="speaker"
          label="Add a speaker by IP address"
          placeholder="192.168.1.100"
          action={{ idle: 'Add speaker', busy: 'Knocking politely…', failed: 'Try again' }}
          value={ip}
          onChange={setIp}
          onTest={() => new Promise(() => {})}
          list={['192.168.1.47']}
          listLabel="Added by IP address"
          removeLabel={(address) => `Remove ${address}`}
          onRemove={noop}
        />
      </Card>
    </div>
  );
}

/**
 * A mock of the desktop Speakers view: the view's own actions at md (44), a room card whose
 * Copy URL is a 32 Button hugging its label, and a notice whose action is 32 and X 28.
 * @returns The view
 */
function SpeakersMock(): JSX.Element {
  return (
    <div class="size-mock stack" data-mock="speakers">
      <PageHeader
        title="Speakers"
        summary="4 rooms, 1 casting"
        actions={
          <Cluster>
            <Button size="md" icon="refresh">
              Ask again
            </Button>
            <Button size="md" kind="filled" danger icon="stop">
              Stop all casts
            </Button>
          </Cluster>
        }
      />
      <Notice
        tone="warning"
        lead="No reply from the speakers"
        text="Check the network lets them answer."
        action={{ label: 'Open settings', onClick: noop }}
        onDismiss={noop}
        announce={false}
      />
      <div class="width-compact">
        <Card title="Living Room" level={3} actions={<Badge tone="casting" label="Casting" />}>
          <CopyField
            reveal="onRefusal"
            value="http://192.168.1.20:49400/stream/4f2a/listen.flac"
            action="Copy URL"
            help="Plays in VLC or a browser while the cast lasts."
            {...COPY}
          />
        </Card>
      </div>
    </div>
  );
}

/**
 * The popup's row controls under the rule: Remove and Mute are IconButton md (32); under
 * touch their hit areas grow to 44 with nothing drawn larger.
 * @returns The strip
 */
function PopupMock(): JSX.Element {
  const [level, setLevel] = useState(37);
  return (
    <div class="size-mock stack" data-mock="popup" data-density="popup">
      <p class="label">Popup: Remove and Mute are 32; under touch their hit areas reach 44</p>
      <div class="width-compact size-row">
        <IconButton glyph="volume" label="Mute Kitchen" />
        <Slider
          label="Kitchen volume"
          min={0}
          max={100}
          step={1}
          value={level}
          onChange={setLevel}
        />
        <IconButton glyph="stop" label="Remove Kitchen" />
      </div>
      <div class="width-compact">
        <Chip label="192.168.1.47" mono removeLabel="Remove 192.168.1.47" onRemove={noop} />
      </div>
    </div>
  );
}

/**
 * F-size, the prototype for the Surface Go 2 tap test: the atoms at 32 with their 44 hit
 * areas, and mock Server, Settings and Speakers views on a window. "Show hit areas" in the
 * page header (or `?hits=1`) tints every hit area.
 * @returns The specimen
 */
export function SizeRuleSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      <Atoms />
      <ServerMock />
      <SettingsMock />
      <SpeakersMock />
      <PopupMock />
    </div>
  );
}
