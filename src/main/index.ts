import fs from 'fs'
import os from 'os'
import path from 'path'
import plist from 'plist'
import { v4 } from 'uuid'
import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'child_process'
import fetch from 'node-fetch'
import { PageInfo, EventName, AppInfo, Dict } from '../types'
import { PortPool, readIcnsAsImageUri } from './utils'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  // eslint-disable-line global-require
  app.quit()
}

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | null = null

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
    },
  })

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)

  // Open the DevTools.
  mainWindow.webContents.openDevTools()

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow)

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow()
  }
})

// read absolute directories
async function readdirAbsolute(dir: string) {
  try {
    const dirs = await fs.promises.readdir(dir)
    return dirs.map(file => path.join(dir, file))
  } catch (err) {
    return []
  }
}

async function getPossibleAppPaths() {
  switch (process.platform) {
    case 'win32': {
      const apps = await Promise.all(
        [
          os.homedir() + '/AppData/Local',
          'c:/Program Files',
          'c:/Program Files (x86)',
        ].map(dir => readdirAbsolute(dir)),
      )
      return apps.flat()
    }
    case 'darwin':
      return readdirAbsolute('/Applications')
    default:
      return []
  }
}

async function isElectronApp(appPath: string) {
  switch (process.platform) {
    case 'win32': {
      try {
        const dirs = await fs.promises.readdir(appPath)
        const [dir] = dirs.filter(name => name.startsWith('app-'))
        return (
          dir &&
          fs.existsSync(path.join(appPath, dir, 'resources/electron.asar'))
        )
      } catch (err) {
        // catch errors of readdir
        // 1. file: ENOTDIR: not a directory
        // 2. no permission at windows: EPERM: operation not permitted
        // console.error(err.message)
        return false
      }
    }
    case 'darwin':
      return fs.existsSync(
        path.join(appPath, 'Contents/Frameworks/Electron Framework.framework'),
      )
    default:
      return false
  }
}

async function getAppInfo(appPath: string): Promise<AppInfo> {
  switch (process.platform) {
    case 'win32':
      const files = await fs.promises.readdir(appPath)
      const exeFiles = files.filter(
        file => file.endsWith('.exe') && !file.startsWith('Uninstall'),
      )
      return {
        id: v4(), // TODO: get app id from register
        name: path.basename(appPath),
        icon: '',
        appPath,
        exePath: exeFiles[0],
      }
    case 'darwin':
      const infoContent = await fs.promises.readFile(
        path.join(appPath, 'Contents/Info.plist'),
        { encoding: 'utf8' },
      )
      const info = plist.parse(infoContent) as {
        CFBundleIdentifier: string
        CFBundleDisplayName: string
        CFBundleExecutable: string
        CFBundleIconFile: string
      }

      const icon = await readIcnsAsImageUri(
        path.join(appPath, 'Contents', 'Resources', info.CFBundleIconFile),
      )

      return {
        id: info.CFBundleIdentifier,
        name: info.CFBundleDisplayName,
        icon,
        appPath,
        exePath: path.resolve(
          appPath,
          'Contents',
          'MacOS',
          info.CFBundleExecutable,
        ),
      }
    default:
      throw new Error('platform not supported: ' + process.platform)
  }
}

async function getExecutable(appPath: string) {
  switch (process.platform) {
    case 'win32': {
      const appName = path.basename(appPath)
      return path.join(appPath, appName + '.exe')
    }
    case 'darwin': {
      const exesDir = path.join(appPath, 'Contents/MacOS')
      const [exe] = await fs.promises.readdir(exesDir)
      return path.join(exesDir, exe)
    }
    default:
      throw new Error('platform not supported: ' + process.platform)
  }
}

const portPool = new PortPool()

async function startDebugging(app: AppInfo) {
  const { appPath } = app
  const nodePort = portPool.getPort()
  const windowPort = portPool.getPort()

  const executable =
    path.extname(appPath) === '.exe' ? appPath : await getExecutable(appPath)
  const sp = spawn(executable, [
    `--inspect=${nodePort}`,
    `--remote-debugging-port=${windowPort}`,
  ])

  let fetched = false
  let instanceId = v4()
  mainWindow!.webContents.send(EventName.appPrepare, instanceId, app.id)

  sp.stdout.on('data', data => {
    mainWindow!.webContents.send(EventName.log, instanceId, data)
  })

  sp.stderr.on('data', async data => {
    // waiting for stderr output to ensure debugger port is already listening
    if (!fetched) {
      fetched = true

      // Window port is not ready, use a timeout
      setTimeout(async () => {
        const [json0, json1] = (await Promise.all(
          [nodePort, windowPort].map(port =>
            fetch(`http://127.0.0.1:${port}/json`).then(res => res.json()),
          ),
        )) as [PageInfo[], PageInfo[]]

        if (!mainWindow) throw new Error('main window already destroyed')
        mainWindow.webContents.send(EventName.appStarted, instanceId, [
          ...json0,
          ...json1,
        ])
      }, 500)
    }

    mainWindow!.webContents.send(EventName.log, instanceId, data)
  })

  sp.on('close', code => {
    console.log(`child process exited with code ${code}`)
    mainWindow!.webContents.send(EventName.appClosed, instanceId)
  })
}

ipcMain.on(EventName.getApps, async (e: Electron.Event) => {
  const appPaths = await getPossibleAppPaths()
  const infos = [] as AppInfo[]
  for (let p of appPaths) {
    // TODO: parallel
    if (await isElectronApp(p)) {
      const info = await getAppInfo(p)
      infos.push(info)
    }
  }

  e.returnValue = infos.reduce(
    (a, b) => {
      a[b.id] = b
      return a
    },
    {} as Dict<AppInfo>,
  )
})

ipcMain.on(EventName.startDebugging, (e: Electron.Event, appInfo: AppInfo) => {
  startDebugging(appInfo)
})