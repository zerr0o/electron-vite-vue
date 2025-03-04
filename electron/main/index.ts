import { app, BrowserWindow, shell, ipcMain, screen , globalShortcut } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import { Device } from '../../src/types/device'
import { StreamOptions } from '../../src/services/ScrcpyService'
import { c } from 'vite/dist/node/types.d-aGj9QkWt'
import { get } from 'node:http'

const execAsync = promisify(exec)
const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// ADB binary path
const ADB_PATH = path.join(process.env.VITE_PUBLIC, 'scrcpy', 
  process.platform === 'win32' ? 'adb.exe' : 'adb')

// SCRCPY binary path - can be customized from the app settings
const SCRCPY_PATH = path.join(process.env.VITE_PUBLIC, 'scrcpy', 
  process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy')

// Store active scrcpy processes
const activeStreams = new Map<string, ChildProcess>()

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: 'STMB Streaming interface',
    autoHideMenuBar: true,
    fullscreen: !VITE_DEV_SERVER_URL,
    minHeight:1080,
    minWidth:1920,
    webPreferences: {
      preload,
      // We're using contextBridge for security
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Check if ADB is available and install if not
async function setupADB() {
  try {
    if (!fs.existsSync(ADB_PATH)) {
      console.log('ADB binary not found, needs to be installed')
      
      // Create directory if it doesn't exist
      const adbDir = path.dirname(ADB_PATH)
      if (!fs.existsSync(adbDir)) {
        fs.mkdirSync(adbDir, { recursive: true })
      }
      
      // Show message dialog to user
      if (win) {
        // We need to delay this slightly until the window is ready
        setTimeout(() => {
          const options = {
            type: 'warning',
            title: 'ADB Not Found',
            message: 'ADB binary not found. You need to download ADB and place it in the specified folder.',
            detail: `Please download ADB from the Android SDK Platform Tools and place it at: ${ADB_PATH}`,
            buttons: ['OK'],
            defaultId: 0
          }
          
          const { dialog } = require('electron')
          dialog.showMessageBoxSync(win!, options)
        }, 1000)
      }
      
      console.log(`Please install ADB manually in: ${adbDir}`)
      return false
    }
    
    // Start ADB server
    await execAsync(`"${ADB_PATH}" start-server`)
    console.log('ADB server started successfully')
    return true
  } catch (error) {
    console.error('Error setting up ADB:', error)
    return false
  }
}

// ========== ADB Command Handlers ==========

// Parse device list from ADB output
function parseDeviceList(output: string): Device[] {
  const devices: Device[] = []
  const lines = output.trim().split('\n')
  
  // Skip the first line which is just a header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    
    const [id, status , product , model] = line.split(/\s+/)
        
    // Skip unauthorized devices
    if (status === 'unauthorized') continue
    
    // Check if it's an IP address
    const isIpDevice = id.includes(':')
    let ip = ''
    let name = id
    
    if (isIpDevice) {
      ip = id.split(':')[0]
      // Use last segment of IP as name
      const ipSegments = ip.split('.')
      name = ipSegments[ipSegments.length - 1]
    }
      
    devices.push({
      id,
      ip,
      name,
      status: status === 'device' ? 'connected' : 'disconnected',
      model : model.replace('model:', '').replace('_', '')
    })
  }
  
  return devices
}


// get screen dimensions using dumpsys window displays
async function getScreenDimensions(deviceId: string): Promise<{ width: number, height: number }> {


  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" -s ${deviceId} shell dumpsys display`)
    return parseScreenDimensions(stdout)
  } catch (error) {
    console.error(`Error getting screen dimensions for ${deviceId}:`, error)
    return { width: 0, height: 0 }
  }

}


function parseScreenDimensions(output) {

  const widthMatch = output.match(/width=(\d+)/);
  const heightMatch = output.match(/height=(\d+)/);
  
  if (widthMatch && heightMatch) {
    
    return {
      width: parseInt(widthMatch[1]),
      height: parseInt(heightMatch[1])
    };
  }
  
  return null;
}
   

// Get battery level using dumpsys
async function getBatteryLevel(deviceId: string): Promise<number> {
  try {
    // Get the full battery dump without using grep (which isn't available on Windows)
    const { stdout } = await execAsync(`"${ADB_PATH}" -s ${deviceId} shell dumpsys battery`)
    
    // Parse battery level from output
    const match = stdout.match(/level:\s*(\d+)/)
    if (match && match[1]) {
      return parseInt(match[1], 10)
    }
    
    return -1
  } catch (error) {
    console.error(`Error getting battery level for ${deviceId}:`, error)
    return -1
  }
}

// Get device IP address by running ip route command
async function getDeviceIpAddress(deviceId: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" -s ${deviceId} shell ip route`)
    
    // Extract IP from output like "192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.22"
    const match = stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)
    if (match && match[1]) {
      return match[1]
    }
    
    return null
  } catch (error) {
    console.error(`Error getting IP address for ${deviceId}:`, error)
    return null
  }
}

// Convert USB device to TCP/IP mode and auto-connect
async function convertUsbToTcpIp(deviceId: string): Promise<{ 
  success: boolean, 
  ipAddress: string | null,
  oldId: string,
  newId: string | null
}> {
  try {
    // 1. Get the device's IP address
    const ipAddress = await getDeviceIpAddress(deviceId)
    if (!ipAddress) {
      console.error(`Could not determine IP address for device ${deviceId}`)
      return { 
        success: false, 
        ipAddress: null,
        oldId: deviceId,
        newId: null
      }
    }
    
    // 2. Enable TCP/IP mode on the device
    const { stdout } = await execAsync(`"${ADB_PATH}" -s ${deviceId} tcpip 5555`)
    if (!stdout.includes('restarting in TCP mode')) {
      console.error(`Failed to enable TCP/IP mode for ${deviceId}`)
      return { 
        success: false, 
        ipAddress,
        oldId: deviceId,
        newId: null
      }
    }
    
    // 3. Wait a moment for the device to restart in TCP mode
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // 4. Connect to the device via IP
    const newId = `${ipAddress}:5555`
    const { stdout: connectOutput } = await execAsync(`"${ADB_PATH}" connect ${newId}`)
    const success = connectOutput.includes('connected')
    
    return { 
      success, 
      ipAddress,
      oldId: deviceId,
      newId: success ? newId : null
    }
  } catch (error) {
    console.error(`Error converting device ${deviceId} to TCP/IP mode:`, error)
    return { 
      success: false, 
      ipAddress: null,
      oldId: deviceId,
      newId: null
    }
  }
}

// Variable to track if ADB is properly set up
let isAdbReady = false;

// ========== IPC Handlers for ADB ==========

// Helper function to check if ADB is installed
const checkAdbInstalled = () => {
  if (!isAdbReady && !fs.existsSync(ADB_PATH)) {
    if (win) {
      const { dialog } = require('electron')
      dialog.showMessageBoxSync(win, {
        type: 'error',
        title: 'ADB Not Found',
        message: 'ADB binary is required but not found',
        detail: `Please download ADB from the Android SDK Platform Tools and place it at: ${ADB_PATH}`,
        buttons: ['OK']
      })
    }
    return false
  }
  return true
}

// Get all connected devices
ipcMain.handle('adb:get-devices', async () => {
  if (!checkAdbInstalled()) {
    return []
  }
  
  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" devices -l`)
    return parseDeviceList(stdout)
  } catch (error) {
    console.error('Error getting devices:', error)
    // If we get an error related to adb not found, show the dialog
    if (error instanceof Error && error.message.includes('n\'est pas reconnu')) {
      checkAdbInstalled()
    }
    return []
  }
})

// Connect to a device
ipcMain.handle('adb:connect', async (_, ipAddress: string) => {
  if (!checkAdbInstalled()) {
    return false
  }
  
  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" connect ${ipAddress}`)
    return stdout.includes('connected')
  } catch (error) {
    console.error(`Error connecting to ${ipAddress}:`, error)
    return false
  }
})

// Disconnect from a device
ipcMain.handle('adb:disconnect', async (_, ipAddress: string) => {
  if (!checkAdbInstalled()) {
    return false
  }
  
  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" disconnect ${ipAddress}`)
    return stdout.includes('disconnected')
  } catch (error) {
    console.error(`Error disconnecting from ${ipAddress}:`, error)
    return false
  }
})

// Get battery level
ipcMain.handle('adb:battery-level', async (_, deviceId: string) => {
  if (!checkAdbInstalled()) {
    return -1
  }
  
  return await getBatteryLevel(deviceId)
})

// Get screen dimensions
ipcMain.handle('adb:screen-dimensions', async (_, deviceId: string) => {
  if (!checkAdbInstalled()) {
    return { width: 0, height: 0 }
  }
  
  return await getScreenDimensions(deviceId)
})

// Enable TCP/IP mode
ipcMain.handle('adb:enable-tcpip', async (_, deviceId: string) => {
  if (!checkAdbInstalled()) {
    return false
  }
  
  try {
    const { stdout } = await execAsync(`"${ADB_PATH}" -s ${deviceId} tcpip 5555`)
    return stdout.includes('restarting in TCP mode')
  } catch (error) {
    console.error(`Error enabling TCP/IP mode for ${deviceId}:`, error)
    return false
  }
})

// Get device IP address
ipcMain.handle('adb:get-ip-address', async (_, deviceId: string) => {
  if (!checkAdbInstalled()) {
    return null
  }
  
  return await getDeviceIpAddress(deviceId)
})

// Convert USB device to TCP/IP and connect
ipcMain.handle('adb:usb-to-tcpip', async (_, deviceId: string) => {
  if (!checkAdbInstalled()) {
    return { success: false, ipAddress: null }
  }
  
  return await convertUsbToTcpIp(deviceId)
})

// ========== SCRCPY Functions ==========

// Check if scrcpy is available
async function isScrcpyInstalled(): Promise<boolean> {
  try {
    // First check our bundled version
    if (fs.existsSync(SCRCPY_PATH)) {
      return true
    }
    
    // Then check PATH
    const { stdout } = await execAsync('scrcpy --version')
    console.log('scrcpy version:', stdout)
    return stdout.includes('scrcpy')
  } catch (error) {
    console.error('Error checking scrcpy:', error)
    return false
  }
}

// Convert stream options to command line arguments
function optionsToArgs(options: StreamOptions): string[] {
  const args: string[] = []
  
  if (options.width && options.height) {
    args.push('--window-width', options.width.toString())
    args.push('--window-height', options.height.toString())
  }
  
  if (options.x !== undefined && options.y !== undefined) {
    args.push('--window-x', options.x.toString())
    args.push('--window-y', options.y.toString())
  }

  if (options.maxFps) {
    args.push('--max-fps', options.maxFps)
  }
  else
  {
    args.push('--max-fps', '25')
  }
  
  if (options.borderless || options.noBorder) {
    args.push('--window-borderless')
  }
  
  if (options.alwaysOnTop) {
    args.push('--always-on-top')
  }
  
  if (options.fullscreen) {
    args.push('--fullscreen')
  }
  
  if (options.maxSize) {
    args.push('--max-size', options.maxSize.toString())
  }
  
  if (options.bitrate) {
    args.push('--video-bit-rate', options.bitrate.toString() + 'K')
  }
  
  if (options.frameRate) {
    args.push('--max-fps', options.frameRate.toString())
  }
  
  if (options.crop) {
    args.push('--crop', options.crop)
  }
  
  if (options.noControl) {
    args.push('--no-control')
  }
  
  if (options.displayId !== undefined) {
    args.push('--display', options.displayId.toString())
  }
  
  
  return args
}

// Start a scrcpy stream for a device
async function startStream(deviceId: string, options: StreamOptions): Promise<boolean> {
  try {
    // Check if we already have a stream for this device
    if (activeStreams.has(deviceId)) {
      console.log(`Stream already running for device ${deviceId}`)
      return true
    }
    
    // Check if scrcpy is available
    const scrcpyAvailable = await isScrcpyInstalled()
    if (!scrcpyAvailable) {
      console.error('scrcpy is not installed')
      return false
    }
    
    // Prepare arguments
    const args = optionsToArgs(options)
    
    // Add the device ID
    args.push('--serial', deviceId)
    
    // Log the command
    console.log(`Starting scrcpy for ${deviceId} with args:`, args.join(' '))
    
    // Spawn the process
    const process = spawn(SCRCPY_PATH, args, {
      detached: false,
      shell: false
    })
    
    // Handle process events
    process.on('error', (error) => {
      console.error(`Error starting scrcpy for ${deviceId}:`, error)
      activeStreams.delete(deviceId)
    })
    
    process.on('close', (code) => {
      console.log(`scrcpy process for ${deviceId} exited with code ${code}`)
      activeStreams.delete(deviceId)
    })
    
    // Store the process
    activeStreams.set(deviceId, process)
    
    return true
  } catch (error) {
    console.error(`Failed to start scrcpy for ${deviceId}:`, error)
    return false
  }
}

// Stop a scrcpy stream for a device
async function stopStream(deviceId: string): Promise<boolean> {
  try {
    const process = activeStreams.get(deviceId)
    if (!process) {
      console.log(`No active stream for device ${deviceId}`)
      return true
    }
    
    // Kill the process
    process.kill()
    activeStreams.delete(deviceId)
    
    return true
  } catch (error) {
    console.error(`Failed to stop scrcpy for ${deviceId}:`, error)
    return false
  }
}

// Stop all scrcpy streams
async function stopAllStreams(): Promise<boolean> {
  try {
    for (const [deviceId, process] of activeStreams.entries()) {
      try {
        process.kill()
        console.log(`Stopped stream for ${deviceId}`)
      } catch (error) {
        console.error(`Error stopping stream for ${deviceId}:`, error)
      }
    }
    
    activeStreams.clear()
    return true
  } catch (error) {
    console.error('Failed to stop all streams:', error)
    return false
  }
}

// ========== IPC Handlers for SCRCPY ==========

// Check if scrcpy is installed
ipcMain.handle('scrcpy:is-installed', async () => {
  return await isScrcpyInstalled()
})

// Start streaming a device
ipcMain.handle('scrcpy:start-stream', async (_, deviceId: string, options: StreamOptions) => {
  if (!checkAdbInstalled()) {
    return false
  }
  
  return await startStream(deviceId, options)
})

// Stop streaming a device
ipcMain.handle('scrcpy:stop-stream', async (_, deviceId: string) => {
  return await stopStream(deviceId)
})

// Stop all streams
ipcMain.handle('scrcpy:stop-all-streams', async () => {
  return await stopAllStreams()
})

// Get active streams
ipcMain.handle('scrcpy:get-active-streams', () => {
  return Array.from(activeStreams.keys())
})

// When the app is ready
app.whenReady().then(async () => {
  isAdbReady = await setupADB()
  await createWindow()

  // Test actively push message to the Electron-Renderer  // Enregistrer la touche Échap comme raccourci global
  const ret = globalShortcut.register('Escape', () => {
    console.log('Touche Échap détectée globalement!');
    stopAllStreams()
  });

  if (!ret) {
    console.log('Échec de l\'enregistrement de la touche Échap');
  }

})


// Libérer le raccourci à la fermeture
app.on('will-quit', () => {
  globalShortcut.unregister('Escape');
  // Ou pour désinscrire tous les raccourcis
  // globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  win = null
  
  // Stop all streams when app is closed
  stopAllStreams()
    .then(() => {
      console.log('All streams stopped on app close')
    })
    .catch(error => {
      console.error('Error stopping streams on app close:', error)
    })
    .finally(() => {
      if (process.platform !== 'darwin') app.quit()
    })
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})
