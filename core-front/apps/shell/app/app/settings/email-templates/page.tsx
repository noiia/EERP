import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { hasPermission, T } from '@eerp/core-front'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getMailTemplates } from '@/lib/mail-templates'
import EmailTemplatesForm from './EmailTemplatesForm'

// Settings → Email templates: the transactional emails modules register
// (internal/mail, ADR-027), reworded and translated per workspace.
export default async function EmailTemplatesPage() {
  await requireAuth('/settings/email-templates')
  const [templates, permissions] = await Promise.all([getMailTemplates(), getEffectivePermissions()])
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          <T text="Email templates" />
        </Typography>
        <EmailTemplatesForm templates={templates} canEdit={hasPermission(permissions, 'settings:mail_templates:write')} />
      </Stack>
    </Container>
  )
}
