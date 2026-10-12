import { useTranslation } from 'react-i18next';
import { Dialog } from '@thaumic-cast/ui';
import { stopAll, toast } from '../state/store';

interface StopAllDialogProps {
  /** Open. */
  open: boolean;
  /** Called when it closes, confirmed or not. */
  onClose: () => void;
}

/**
 * "Stop all casts" asks first (DESIGN.md P-stop, owner call 2): every cast on this server
 * ends, other people's included. On Stop, the toast row says what stopped, in the tray's
 * words: how many casts, and how many of them were started on another computer.
 * @param props - Component props
 * @param props.open - Open
 * @param props.onClose - Called when it closes
 * @returns The dialog
 */
export function StopAllDialog({ open, onClose }: StopAllDialogProps) {
  const { t } = useTranslation();
  const stop = async (): Promise<void> => {
    const { stopped, remote } = await stopAll();
    const words = [t('server.stopped', { count: stopped })];
    if (remote > 0) words.push(t('server.stopped_remote', { count: remote }));
    toast.value = words.join(' ');
  };
  return (
    <Dialog
      open={open}
      title={t('server.stop_streams')}
      description={t('server.stop_streams_description')}
      cancelLabel={t('cancel')}
      closeLabel={t('close')}
      confirm={{ label: t('server.stop'), glyph: 'stop', danger: true, onAction: stop }}
      onClose={onClose}
    />
  );
}
