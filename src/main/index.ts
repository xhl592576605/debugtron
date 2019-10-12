import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { forwardToRenderer, replayActionMain } from 'electron-redux'
import { applyMiddleware, createStore } from 'redux'
import thunk from 'redux-thunk'
import { updatePages } from '../reducers/session'
import { getElectronApps, startDebugging, getAppInfoByDnd } from './utils'
import { setUpdater } from './updater'
import { PageInfo, Dict } from '../types'
import fetch from 'node-fetch'
import { getApps, addTempApp } from '../reducers/app'
import reducers from '../reducers'

const store = createStore(reducers, applyMiddleware(thunk, forwardToRenderer))
replayActionMain(store)

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
    },
  })

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
  // mainWindow.webContents.openDevTools()

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const fetchPages = async () => {
  const { sessionInfo } = store.getState()
  for (let [id, info] of Object.entries(sessionInfo)) {
    const ports: string[] = []
    if (info.nodePort) ports.push(info.nodePort)
    if (info.windowPort) ports.push(info.windowPort)

    const payloads = await Promise.all(
      ports.map(port =>
        fetch(`http://127.0.0.1:${port}/json`).then(res => res.json()),
      ),
    )

    const pages = payloads.flat() as PageInfo[]
    if (pages.length === 0) return

    const pageDict = pages.reduce(
      (a, b) => {
        a[b.id] = b
        return a
      },
      {} as Dict<PageInfo>,
    )

    store.dispatch(updatePages(id, pageDict))
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('ready', async () => {
    // TODO: Uncomment after https://github.com/MarshallOfSound/electron-devtools-installer/pull/92 merged
    // if (!app.isPackaged) {
    //   const installer = require('electron-devtools-installer')
    //   await Promise.all(
    //     ['REACT_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS'].map(name =>
    //       installer.default(installer[name]),
    //     ),
    //   )
    // }

    setUpdater()
    createWindow()
    setInterval(fetchPages, 3000)

    const apps = await getElectronApps()
    store.dispatch(getApps(apps))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow()
    }
  })

  ipcMain.on(
    'startDebuggingWithExePath',
    async (e: Electron.Event, exePath: string) => {
      const { appInfo } = store.getState()
      const duplicated = Object.values(appInfo).find(a => a.exePath === exePath)
      if (duplicated) {
        startDebugging(duplicated, store)
        return
      }

      const current = await getAppInfoByDnd(exePath)
      if (current) {
        store.dispatch(addTempApp(current)) // TODO: Remove it after session closed
        startDebugging(current, store)
      } else {
        dialog.showErrorBox(
          'Invalid application path',
          `${exePath} is not a valid application`,
        )
      }
    },
  )

  ipcMain.on('startDebugging', async (e: Electron.Event, id: string) => {
    const { appInfo } = store.getState()
    startDebugging(appInfo[id], store)
  })
}
