document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const geminiKeyInput = document.getElementById('geminiKey');
    const outputLanguageSelect = document.getElementById('outputLanguage');
    const meetingAudioLanguageSelect = document.getElementById('meetingAudioLanguage');
    const btnTestLlm = document.getElementById('btnTestLlm');
    const llmTestResult = document.getElementById('llmTestResult');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');

    // ── Nyx parity: features section elements ──
    const invisibilitySelect = document.getElementById('invisibilityMode');
    const preferredDisplaySelect = document.getElementById('preferredDisplay');
    const autoLaunchSelect = document.getElementById('autoLaunch');
    const calendarAutoAttendSelect = document.getElementById('calendarAutoAttend');
    const btnTutorial = document.getElementById('btnTutorial');
    const appVersionEl = document.getElementById('appVersion');
    const appVersionText = document.getElementById('appVersionText');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults).
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (outputLanguageSelect) outputLanguageSelect.value = settings.outputLanguage || 'English';
        if (meetingAudioLanguageSelect) meetingAudioLanguageSelect.value = settings.meetingAudioLanguage || 'auto';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Nyx parity feature toggles (loaded async from main below)
        if (invisibilitySelect) {
            window.electronAPI.getInvisibilityMode().then(on => {
                invisibilitySelect.value = on ? 'on' : 'off';
            }).catch(() => {});
        }
        if (autoLaunchSelect) {
            window.electronAPI.getAutoLaunch().then(on => {
                autoLaunchSelect.value = on ? 'on' : 'off';
            }).catch(() => {});
        }
        if (calendarAutoAttendSelect) {
            window.electronAPI.getCalendarAutoAttend().then(on => {
                calendarAutoAttendSelect.value = on ? 'on' : 'off';
            }).catch(() => {});
        }
        populateDisplays();
        loadAppVersion();

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });
    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (outputLanguageSelect) settings.outputLanguage = outputLanguageSelect.value;
        if (meetingAudioLanguageSelect) settings.meetingAudioLanguage = meetingAudioLanguageSelect.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        // Transcription is Gemini-only now — no key fields to toggle.
    };

    // Add event listeners for all inputs
    const inputs = [
        geminiKeyInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    [outputLanguageSelect, meetingAudioLanguageSelect].forEach(input => {
        if (input) input.addEventListener('change', saveSettings);
    });

    // ── Nyx parity feature handlers ──
    if (invisibilitySelect) {
        invisibilitySelect.addEventListener('change', async () => {
            try {
                await window.electronAPI.setInvisibilityMode(invisibilitySelect.value);
            } catch (e) { console.error('Invisibility toggle failed:', e); }
        });
    }
    if (preferredDisplaySelect) {
        preferredDisplaySelect.addEventListener('change', async () => {
            try {
                if (preferredDisplaySelect.value) {
                    await window.electronAPI.setPreferredDisplay(preferredDisplaySelect.value);
                }
            } catch (e) { console.error('Display change failed:', e); }
        });
    }
    if (autoLaunchSelect) {
        autoLaunchSelect.addEventListener('change', async () => {
            try {
                await window.electronAPI.setAutoLaunch(autoLaunchSelect.value === 'on');
            } catch (e) { console.error('Auto-launch toggle failed:', e); }
        });
    }
    if (calendarAutoAttendSelect) {
        calendarAutoAttendSelect.addEventListener('change', async () => {
            try {
                await window.electronAPI.setCalendarAutoAttend(calendarAutoAttendSelect.value === 'on');
            } catch (e) { console.error('Calendar auto-attend toggle failed:', e); }
        });
    }
    if (btnTutorial) {
        btnTutorial.addEventListener('click', () => {
            window.electronAPI.openExternal('https://github.com/devansh0703/Nyx#readme');
        });
    }

    // Populate the display selector (Nyx "Change display")
    async function populateDisplays() {
        if (!preferredDisplaySelect) return;
        try {
            const displays = await window.electronAPI.listDisplaysForSettings();
            if (!displays || !displays.length) return;
            preferredDisplaySelect.innerHTML = '<option value="">Auto (current)</option>' +
                displays.map(d => `<option value="${escAttr(d.id)}">${escHtml(d.label)}</option>`).join('');
        } catch (e) { console.error('Failed to list displays:', e); }
    }

    // Show the current app version (Nyx "App version" row)
    async function loadAppVersion() {
        if (!appVersionEl) return;
        try {
            const info = await window.electronAPI.getAppVersion();
            appVersionEl.textContent = info.version || '—';
            if (appVersionText) {
                appVersionText.textContent = info.electron
                    ? `Electron ${info.electron} · up to date`
                    : 'Up to date';
            }
        } catch (_) {
            appVersionEl.textContent = '—';
        }
    }

    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escAttr(s) {
        return String(s ?? '').replace(/["'&<>]/g, c => ({ '"': '&quot;', "'": '&#39;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }

    // ── Editable keyboard shortcuts (Nyx Settings → Shortcuts) ──
    async function renderShortcuts() {
        const list = document.getElementById('shortcutList');
        if (!list) return;
        try {
            const shortcuts = await window.electronAPI.getShortcuts();
            list.innerHTML = shortcuts.map(s => `
                <div class="settings-item" data-shortcut="${escAttr(s.id)}">
                    <div>
                        <div class="settings-item-label">${escHtml(s.id.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()))}</div>
                        <div class="settings-item-description">${s.disabled ? 'Disabled' : escHtml(s.accelerator || s.default)}</div>
                    </div>
                    <div style="display:flex;gap:6px">
                        <button class="input-field shortcut-edit" style="width:auto;padding:4px 10px;font-size:11px;cursor:pointer">Edit</button>
                        <button class="input-field shortcut-toggle" style="width:auto;padding:4px 10px;font-size:11px;cursor:pointer">${s.disabled ? 'Enable' : 'Disable'}</button>
                    </div>
                </div>`).join('');

            list.querySelectorAll('[data-shortcut]').forEach(row => {
                const id = row.dataset.shortcut;
                const editBtn = row.querySelector('.shortcut-edit');
                const toggleBtn = row.querySelector('.shortcut-toggle');

                editBtn.addEventListener('click', () => {
                    const current = row.querySelector('.settings-item-description').textContent;
                    const next = prompt(`New accelerator for "${id}"\n(e.g. CommandOrControl+Shift+9, or type "disabled"):\n\nCurrent: ${current}`);
                    if (next === null) return; // cancelled
                    window.electronAPI.setShortcut(id, next.trim()).then(() => renderShortcuts());
                });

                toggleBtn.addEventListener('click', () => {
                    const disabled = toggleBtn.textContent.trim() === 'Disable';
                    window.electronAPI.setShortcut(id, disabled ? 'disabled' : '').then(() => renderShortcuts());
                });
            });
        } catch (e) {
            console.error('Failed to render shortcuts:', e);
        }
    }

    const btnResetShortcuts = document.getElementById('btnResetShortcuts');
    if (btnResetShortcuts) {
        btnResetShortcuts.addEventListener('click', async () => {
            try {
                await window.electronAPI.resetShortcuts();
                await renderShortcuts();
            } catch (e) { console.error('Reset shortcuts failed:', e); }
        });
    }
    renderShortcuts();

    // Gemini connection test
    if (btnTestLlm) {
        btnTestLlm.addEventListener('click', async () => {
            btnTestLlm.disabled = true;
            btnTestLlm.textContent = 'Testing…';
            llmTestResult.style.display = 'none';
            try {
                const result = await window.electronAPI.testLlmConnection();
                llmTestResult.style.display = '';
                if (result && result.success) {
                    llmTestResult.textContent = `✓ Connected — model replied in ${result.latency}ms`;
                    llmTestResult.style.color = '#34d399';
                } else {
                    llmTestResult.textContent = `✗ ${(result && result.error) || 'Connection failed'}`;
                    llmTestResult.style.color = '#f87171';
                }
            } catch (e) {
                llmTestResult.style.display = '';
                llmTestResult.textContent = '✗ ' + e.message;
                llmTestResult.style.color = '#f87171';
            } finally {
                btnTestLlm.disabled = false;
                btnTestLlm.textContent = 'Test';
            }
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
