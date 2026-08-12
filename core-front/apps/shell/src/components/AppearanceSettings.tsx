'use client'
import type { ReactNode } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  BRAND_COLORS,
  byPrefixAndName,
  FontAwesomeIcon,
  isHexColor,
  useT,
  useUiStore,
} from '@eerp/core-front'
import ReportsGlobalSettings from './ReportsGlobalSettings'

// Settings → Global settings (formerly "Appearance", docs/roadmaps/
// pdf-reports.md's Reports settings subsection): two collapsible sections —
// "Colors" is the ORIGINAL Appearance content, unchanged behavior, just
// relabeled and grouped; "Reports" is new (workspace-wide PDF report
// letterhead + the page-format table, the latter wired in by
// ReportPageFormatList once Phase E lands).
export default function AppearanceSettings({
  canEditReports = false,
  initialFooter = '',
  initialAddress = '',
  reportPageFormats,
}: {
  canEditReports?: boolean
  initialFooter?: string
  initialAddress?: string
  /** The page-format table + Create button — Server Components built by the
   * page and passed down as a slot (a Client Component can render, but never
   * import, a Server Component). Omitted in tests, where there's no server
   * tree to render it from. */
  reportPageFormats?: ReactNode
}) {
  const t = useT()
  const palette = useUiStore((s) => s.palette)
  const mode = useUiStore((s) => s.theme)
  const setPaletteColor = useUiStore((s) => s.setPaletteColor)
  const resetPalette = useUiStore((s) => s.resetPalette)
  const setTheme = useUiStore((s) => s.setTheme)

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Global settings')}
          </Typography>
          <Typography color="text.secondary">
            {t('Colors, PDF report layout, and more.')}
          </Typography>
        </Stack>

        <Accordion defaultExpanded disableGutters>
          <AccordionSummary
            expandIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-down']} />}
          >
            <Typography variant="subtitle1">{t('Colors')}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={3}>
              <Typography color="text.secondary">
                {t(
                  'Customize the brand colors used across the interface. Changes apply instantly and are saved on this device.',
                )}
              </Typography>

              <FormControlLabel
                control={
                  <Switch
                    checked={mode === 'dark'}
                    onChange={(e) => setTheme(e.target.checked ? 'dark' : 'light')}
                    slotProps={{ input: { 'aria-label': 'Dark mode' } }}
                  />
                }
                label={t('Dark mode')}
              />

              <Stack spacing={2}>
                {BRAND_COLORS.map((color) => {
                  const value = palette[color.key]
                  const valid = isHexColor(value)
                  return (
                    <Box
                      key={color.key}
                      sx={{
                        display: 'flex',
                        gap: 2,
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                      }}
                    >
                      {/* Native color swatch + a hex field that stay in sync. The native input
                          paints its color as an inner swatch, so we round/clip its pseudo-elements
                          (not just the host element) to get a true circle, not a rect-in-circle. */}
                      <Box
                        component="input"
                        type="color"
                        aria-label={`${color.label} swatch`}
                        value={valid ? value : '#000000'}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setPaletteColor(color.key, e.target.value)
                        }
                        sx={{
                          width: 32,
                          height: 32,
                          p: 0,
                          border: 'none',
                          borderRadius: '50%',
                          background: 'none',
                          cursor: 'pointer',
                          overflow: 'hidden',
                          appearance: 'none',
                          WebkitAppearance: 'none',
                          boxShadow: (t) => `inset 0 0 0 1px ${t.palette.divider}`,
                          '&::-webkit-color-swatch-wrapper': { p: 0 },
                          '&::-webkit-color-swatch': { border: 'none', borderRadius: '50%' },
                          '&::-moz-color-swatch': { border: 'none', borderRadius: '50%' },
                        }}
                      />
                      <Box sx={{ flex: 1, minWidth: 220 }}>
                        <Typography variant="subtitle1">{color.label}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                          {color.description}
                        </Typography>
                        <TextField
                          size="small"
                          label="Hex"
                          value={value}
                          error={!valid}
                          helperText={valid ? undefined : 'Enter a hex color, e.g. #1E293B'}
                          onChange={(e) => setPaletteColor(color.key, e.target.value)}
                          slotProps={{ htmlInput: { 'aria-label': `${color.label} hex` } }}
                        />
                      </Box>
                    </Box>
                  )
                })}
              </Stack>

              <Box>
                {/* `inherit` (not secondary): secondary is Deep Ocean, illegible on a dark
                    surface. Inheriting the text color keeps this readable in both modes. */}
                <Button variant="outlined" color="inherit" onClick={resetPalette}>
                  {t('Reset to defaults')}
                </Button>
              </Box>

              <Divider />

              {/* Live preview: themed straight off the store the controls above edit. */}
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    {t('Preview')}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                    <Button variant="contained" color="primary">
                      Primary action
                    </Button>
                    <Button variant="contained" color="secondary">
                      Secondary
                    </Button>
                    <Chip label="Success" color="success" />
                    <Typography color="text.secondary">Secondary text</Typography>
                  </Box>
                </CardContent>
              </Card>
            </Stack>
          </AccordionDetails>
        </Accordion>

        <Accordion disableGutters>
          <AccordionSummary
            expandIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['chevron-down']} />}
          >
            <Typography variant="subtitle1">{t('Reports')}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={3}>
              <ReportsGlobalSettings
                canEdit={canEditReports}
                initialFooter={initialFooter}
                initialAddress={initialAddress}
              />
              <Divider />
              <Stack spacing={2}>
                <Typography variant="subtitle1">{t('Page formats')}</Typography>
                {reportPageFormats}
              </Stack>
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Container>
  )
}
