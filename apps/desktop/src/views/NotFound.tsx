import { useLocation } from 'wouter-preact';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '@thaumic-cast/ui';

/**
 * Not found (DESIGN.md L-desktop): an EmptyState whose title is the page's heading, with a
 * link back to Rooms. No PageHeader.
 * @returns The rendered view
 */
export function NotFound() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  return (
    <EmptyState
      level={1}
      title={t('error.page_not_found')}
      action={
        <Button
          size="md"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          {t('error.go_home')}
        </Button>
      }
    />
  );
}
