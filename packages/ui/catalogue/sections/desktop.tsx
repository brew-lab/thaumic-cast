/*
 * The desktop's parts (DESIGN.md §6, §8, Phase 4). What takes the whole window (a modal
 * Dialog in the top layer, the DesktopShell, the WizardShell) cannot be drawn inside the
 * catalogue's own page, so each is drawn in an iframe of this same catalogue with
 * `?frame=…` (main.tsx renders the frame alone), at a narrow and a default window, in the
 * panel's scheme.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { AnnouncerProvider } from '../../src/Announcer';
import { Button } from '../../src/Button';
import { CopyField } from '../../src/CopyField';
import { DescriptionList } from '../../src/DescriptionList';
import { DesktopShell } from '../../src/DesktopShell';
import { Dialog } from '../../src/Dialog';
import { EmptyState } from '../../src/EmptyState';
import { PageHeader } from '../../src/PageHeader';
import { Rail, type RailItem } from '../../src/Rail';
import { RoomCard } from '../../src/RoomCard';
import { SettingsRow } from '../../src/SettingsRow';
import { SettingsSection } from '../../src/SettingsSection';
import { Switch } from '../../src/Switch';
import { Toast } from '../../src/Toast';
import { Wizard } from '../../src/Wizard';
import { WizardShell } from '../../src/WizardShell';
import { WizardStep } from '../../src/WizardStep';
import { useScheme } from '../scheme';
import { Pressed, fakeClipboard } from './molecules';

/**
 * One window: an iframe of a frame of the catalogue, in the panel's scheme.
 * @param props - Component props
 * @param props.frame - The frame and its query (`dialog&open=1`)
 * @param props.width - The window's width in px
 * @param props.height - The window's height in px
 * @param props.label - What the window shows
 * @returns The window
 */
export function Window({
  frame,
  width,
  height = 480,
  label,
}: {
  frame: string;
  width: number;
  height?: number;
  label: string;
}): JSX.Element {
  const scheme = useScheme();
  return (
    <div class="stack">
      <p class="label">
        {label} · {width} × {height}
      </p>
      <iframe
        class="window-frame"
        loading="lazy"
        style={{ '--window-w': width, '--window-h': height }}
        title={`${label}, ${scheme}`}
        src={`./?frame=${frame}&theme=${scheme}`}
      />
    </div>
  );
}

/**
 * Stop all casts and its Dialog, as the desktop draws them: `?frame=dialog`, with `&open=1`
 * to open it on load and `&fail=1` for a confirm that fails.
 * @returns The frame
 */
export function DialogFrame(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const [open, setOpen] = useState(params.get('open') === '1');
  const fail = params.get('fail') === '1';
  const [stopped, setStopped] = useState(0);
  return (
    <AnnouncerProvider>
      <div class="frame-page" data-density="desktop">
        <p>Two casts are running.</p>
        <div>
          <Button size="md" kind="filled" danger icon="stop" onClick={() => setOpen(true)}>
            Stop all casts
          </Button>
        </div>
        {stopped > 0 && <p data-stopped="">Stopped {stopped} times.</p>}
        <Dialog
          open={open}
          title="Stop all casts"
          description="Stops every cast, including any started from another computer, whose owner has not been consulted."
          cancelLabel="Cancel"
          closeLabel="Close"
          confirm={{
            label: 'Stop',
            glyph: 'stop',
            danger: true,
            failed: 'Try again',
            onAction: () =>
              new Promise((resolve, reject) =>
                setTimeout(() => {
                  if (fail) reject(new Error('no'));
                  else {
                    setStopped((n) => n + 1);
                    resolve(undefined);
                  }
                }, 400),
              ),
          }}
          onClose={() => setOpen(false)}
        />
      </div>
    </AnnouncerProvider>
  );
}

/**
 * Dialog: open in a default and a narrow window (the actions stack under a 25rem dialog).
 * @returns The specimen
 */
export function DialogSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Window frame="dialog&open=1" width={600} height={360} label="open" />
      <Window frame="dialog&open=1" width={360} height={420} label="narrow: the actions stack" />
    </div>
  );
}

/**
 * A cast's Copy URL, as the desktop's RoomCard holds it.
 * @param props - Component props
 * @param props.refuse - The clipboard says no, so the URL is revealed
 * @returns The control
 */
function CastUrl({ refuse = false }: { refuse?: boolean }): JSX.Element {
  return (
    <CopyField
      getValue={async () => 'http://192.168.1.20:49400/stream/8c1f0e2a/listen.wav'}
      action="Copy URL"
      done="Copied"
      refusedNote="The clipboard said no. Here it is, selected, to copy by hand."
      unavailableNote="This computer's address isn't known yet. Try again in a moment."
      reveal="onRefusal"
      clipboard={refuse ? fakeClipboard(false) : undefined}
      help={
        <p>Plays in VLC or a browser while the cast lasts. It won't keep time with the speakers.</p>
      }
    />
  );
}

/**
 * The rooms of a household, as the Speakers view draws them, casting first.
 * @param props - Component props
 * @param props.diagnostics - Show diagnostics is on
 * @returns The cards
 */
function RoomCards({ diagnostics = false }: { diagnostics?: boolean }): JSX.Element {
  return (
    <>
      <RoomCard
        name="Kitchen"
        sub="Grouped with Dining Room"
        badge={{ tone: 'casting', label: 'Casting' }}
        copy={<CastUrl />}
        meter={
          diagnostics
            ? {
                name: 'Reserve',
                label: 'Kitchen reserve',
                value: 1240,
                max: 2000,
                low: 400,
                valueText: '1240 ms',
              }
            : null
        }
      />
      <RoomCard
        name="Dining Room"
        sub="Grouped with Kitchen"
        badge={{ tone: 'casting', label: 'Casting' }}
        copy={<CastUrl />}
        meter={
          diagnostics
            ? {
                name: 'Reserve',
                label: 'Dining Room reserve',
                value: 380,
                max: 2000,
                low: 400,
                valueText: '380 ms',
              }
            : null
        }
      />
      <RoomCard
        name="TV Room"
        sub="Sonos Arc · 192.168.1.40"
        badge={{ tone: 'warning', label: 'In use' }}
      />
      <RoomCard
        name="Bedroom"
        sub="Sonos Era 100 · 192.168.1.44"
        badge={{ tone: 'neutral', label: 'Not playing' }}
      />
      <RoomCard
        name="Study"
        sub="Sonos Era 100 · 192.168.1.48"
        badge={{ tone: 'busy', label: 'Loading' }}
      />
      <RoomCard
        name="The Room Over The Garage With The Long Name"
        sub="Sonos Move · 192.168.1.52"
        badge={{ tone: 'neutral', label: 'Paused' }}
      />
    </>
  );
}

/**
 * RoomCard: the states, in a compact card (18rem, three across at 1280), a medium one and a
 * wide one; a long name wraps, never cut off, and keeps the Badge after it; a refused copy
 * reveals the URL; with diagnostics, the reserve Meter (Dining Room low).
 * @returns The specimen
 */
export function RoomCardSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      {[18, 26, 36].map((rem) => (
        <div key={rem} class="stack">
          <p class="label">{rem}rem cards</p>
          <div class="room-cards" style={{ '--room-card-rem': rem }}>
            <RoomCards diagnostics={rem === 26} />
          </div>
        </div>
      ))}
      <div class="room-cards" style={{ '--room-card-rem': 18 }}>
        <RoomCard
          name="Living Room"
          sub="Sonos Five · 192.168.1.36"
          badge={{ tone: 'casting', label: 'Casting' }}
          copy={
            <Pressed>
              <CastUrl refuse />
            </Pressed>
          }
        />
      </div>
    </div>
  );
}

/** The rail's destinations. */
const RAIL: RailItem[] = [
  { href: '/', icon: 'speaker', label: 'Speakers' },
  { href: '/server', icon: 'server', label: 'Server' },
  { href: '/settings', icon: 'settings', label: 'Settings' },
];

/**
 * The Server view, as the desktop draws it: the address and two counts, then the three
 * actions, whose Buttons share one width.
 * @returns The view
 */
function ServerView(): JSX.Element {
  return (
    <>
      <PageHeader title="Server" />
      <SettingsSection title="Running">
        <DescriptionList
          kind="stat"
          rows={[
            {
              key: 'address',
              term: 'Address',
              value: (
                <CopyField
                  value="192.168.1.20:49400"
                  getValue={async () => 'http://192.168.1.20:49400'}
                  action="Copy address"
                  done="Copied"
                  refusedNote="The clipboard said no. Here it is, selected, to copy by hand."
                  unavailableNote="This computer's address isn't known yet."
                />
              ),
            },
            { key: 'clients', term: 'Extension connections', value: 2, count: true },
            { key: 'casts', term: 'Casts running', value: 2, count: true },
          ]}
        />
      </SettingsSection>
      <SettingsSection title="Actions">
        <SettingsRow
          label="Restart Thaumic Cast"
          help="Closes Thaumic Cast and opens it again, which ends every cast on the way."
          controlWidth="action"
          control={
            <Button icon="refresh" onAction={() => new Promise(() => undefined)}>
              Restart Thaumic Cast
            </Button>
          }
        />
        <SettingsRow
          label="Disconnect extensions"
          help="Hangs up on every extension, which ends every cast. The extensions ring back by themselves in a few seconds; the casts need starting again."
          controlWidth="action"
          control={<Button kind="outline">Disconnect</Button>}
        />
        <SettingsRow
          label="Stop all casts"
          help="Stops every cast, including any started from another computer, whose owner has not been consulted."
          controlWidth="action"
          control={
            <Button kind="filled" danger icon="stop">
              Stop
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}

/**
 * Not found: the EmptyState's title is the page's heading, and its action a link home.
 * @returns The view
 */
function NotFoundView(): JSX.Element {
  return (
    <EmptyState
      level={1}
      title="There is no page here"
      action={
        <Button size="md" href="#" onClick={(event) => event.preventDefault()}>
          Back to Speakers
        </Button>
      }
    />
  );
}

/**
 * The desktop window, as the app draws it: `?frame=desktop&view=speakers|server|notfound`, with
 * `&toast=1` for a Toast in the toast row and `&long=1` for a view long enough to scroll.
 * @returns The frame
 */
export function DesktopFrame(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? 'server';
  const [toast, setToast] = useState(params.get('toast') === '1');
  const long = params.get('long') === '1';
  return (
    <AnnouncerProvider>
      <DesktopShell
        wide={view !== 'server'}
        rail={
          <Rail
            brand={{ name: 'Thaumic Cast', version: 'Version 0.12.0', lit: true }}
            items={RAIL}
            current={view === 'server' ? '/server' : view === 'speakers' ? '/' : ''}
            onNavigate={() => undefined}
            navLabel="Thaumic Cast"
          />
        }
        toast={
          toast && (
            <Toast
              text="Stopped 2 casts. 1 of them was not started on this computer."
              onDismiss={() => setToast(false)}
              dismissLabel="Dismiss"
            />
          )
        }
      >
        {view === 'notfound' ? (
          <NotFoundView />
        ) : view === 'speakers' ? (
          <>
            <PageHeader
              title="Speakers"
              summary="6 rooms, 2 casting"
              actions={
                <>
                  <Button size="md" icon="refresh">
                    Ask again
                  </Button>
                  <Button size="md" kind="filled" danger icon="stop">
                    Stop all casts
                  </Button>
                </>
              }
            />
            <div class="speaker-grid">
              <RoomCards />
            </div>
          </>
        ) : (
          <ServerView />
        )}
        {long && <ServerView />}
      </DesktopShell>
    </AnnouncerProvider>
  );
}

/**
 * The desktop's onboarding, as the app draws it: `?frame=wizard&step=0…2`.
 * @returns The frame
 */
export function WizardFrame(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const [step, setStep] = useState(Number(params.get('step') ?? 0));
  const [autostart, setAutostart] = useState(true);
  const steps = [
    <WizardStep
      key="welcome"
      title="Welcome to Thaumic Cast"
      subtitle="The half that talks to the speakers"
      glyph="cast"
    >
      <p>
        This app finds your Sonos speakers and serves them the audio your browser sends. It lives in
        the system tray and does not need looking at.
      </p>
    </WizardStep>,
    <WizardStep
      key="speakers"
      title="Finding the speakers"
      subtitle="Asking the network who is in"
      glyph="speaker"
    >
      <DescriptionList
        kind="checklist"
        rows={[{ key: 'found', state: 'connected', text: '4 rooms answered.' }]}
      />
    </WizardStep>,
    <WizardStep
      key="ready"
      title="Ready to cast"
      subtitle="The rest happens in the browser"
      glyph="check"
    >
      <Switch
        label="Launch at login"
        description="Starts Thaumic Cast when you log in, so it is running before you remember you wanted it."
        checked={autostart}
        onChange={setAutostart}
      />
    </WizardStep>,
  ];
  return (
    <AnnouncerProvider>
      <WizardShell>
        <Wizard
          currentStep={step}
          totalSteps={steps.length}
          onNext={() => setStep((s) => Math.min(s + 1, steps.length - 1))}
          onBack={() => setStep((s) => Math.max(s - 1, 0))}
          onSkip={() => undefined}
          isFinal={step === steps.length - 1}
          labels={{
            next: 'Carry on',
            back: 'Back',
            skip: 'Skip the formalities',
            finish: "That'll do",
          }}
        >
          {steps[step]}
        </Wizard>
      </WizardShell>
    </AnnouncerProvider>
  );
}

/**
 * DesktopShell: the Server view at the narrow rail (under 45rem) and the wide one, a Toast in
 * the toast row, and Not found.
 * @returns The specimen
 */
export function DesktopShellSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Window
        frame="desktop&view=speakers"
        width={600}
        height={640}
        label="Speakers, narrow rail"
      />
      <Window frame="desktop&view=speakers" width={1280} height={800} label="Speakers, wide rail" />
      <Window frame="desktop&view=server" width={600} height={640} label="narrow rail" />
      <Window
        frame="desktop&view=server&toast=1"
        width={840}
        height={640}
        label="wide rail, a Toast"
      />
      <Window frame="desktop&view=notfound" width={600} height={360} label="Not found" />
    </div>
  );
}

/**
 * WizardShell and the full Wizard: the first step and a later one (Back appears).
 * @returns The specimen
 */
export function WizardShellSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Window frame="wizard&step=0" width={600} height={560} label="step 1" />
      <Window frame="wizard&step=2" width={840} height={560} label="step 3" />
    </div>
  );
}
