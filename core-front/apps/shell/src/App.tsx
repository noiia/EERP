import { CssBaseline, ThemeProvider } from '@mui/material'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import { theme } from './app/theme'

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}
