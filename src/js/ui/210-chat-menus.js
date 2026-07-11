// Chat dropdown menu helpers
function toggleChatDropdown(dropdownId) {
    var dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    var isOpen = dropdown.classList.contains('open');
    closeChatDropdowns();
    if (!isOpen) {
        dropdown.classList.add('open');
    }
}

function closeChatDropdowns() {
    document.querySelectorAll('.chat-dropdown.open').forEach(function(d) {
        d.classList.remove('open');
    });
}

// Close chat dropdowns when clicking outside
document.addEventListener('click', function(e) {
    if (!e.target.closest('.chat-menu-wrapper')) {
        closeChatDropdowns();
    }
});

// Rename current chat from header button
function renameCurrentChat() {
    if (!currentChatId || !chats[currentChatId]) return;
    openRenameModal(currentChatId);
}

// Rename chat modal
function openRenameModal(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
    
    var overlay = document.getElementById('modal-overlay');
    var header = document.getElementById('modal-header');
    var body = document.getElementById('modal-body');
    var actions = document.getElementById('modal-actions');
    
    header.textContent = 'Rename Chat';
    body.innerHTML = '<input type="text" id="rename-chat-input" class="modal-input" value="' + escapeHtml(chat.title) + '" placeholder="Enter new name..." style="width:100%;padding: var(--space-5);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--text-body-lg);box-sizing:border-box;" />';
    actions.innerHTML = '<button class="modal-btn secondary" onclick="closeModal()">Cancel</button>' +
        '<button class="modal-btn primary" onclick="confirmRenameChat(\'' + chatId + '\')">Rename</button>';
    
    overlay.classList.add('show');
    
    setTimeout(function() {
        var input = document.getElementById('rename-chat-input');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
}

function confirmRenameChat(chatId) {
    var input = document.getElementById('rename-chat-input');
    if (!input) return;
    
    var newTitle = input.value.trim();
    if (!newTitle) {
        showSnackbar('Please enter a valid name', 'error');
        return;
    }
    
    var chat = chats[chatId];
    if (chat) {
        chat.title = newTitle;
        // A user-chosen name is authoritative — clear the provisional flag so
        // the auto-title hook doesn't overwrite the manual rename later.
        delete chat.titleProvisional;
        // MEMFIX: a payload-evicted chat is skipped by the diff-save put-loop,
        // so a rename of a non-recent chat would silently never persist —
        // rehydrate first, then save. ensureChatPayloads never rejects.
        if (chat._payloadsEvicted && typeof ensureChatPayloads === 'function') {
            ensureChatPayloads(chatId).then(function() { saveChatsToStorage(); });
        } else {
            saveChatsToStorage();
        }
        renderChatList();
        if (chatId === currentChatId) updateChatTitleHeader();
        showSnackbar('Chat renamed', 'success');
    }
    
    closeModal();
}

// Download chat as JSON
async function downloadChat(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
    // MEMFIX: rehydrate evicted base64 payloads so the export is complete.
    if (typeof ensureChatPayloads === 'function') {
        try { await ensureChatPayloads(chatId); } catch (e) {}
    }
    
    var exportData = {
        exportType: 'single_chat',
        exportDate: new Date().toISOString(),
        chat: chat
    };
    
    var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'chat_' + chat.title.replace(/[^a-z0-9]/gi, '_').substring(0, 30) + '_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showSnackbar('Chat downloaded', 'success');
}

// Import a single chat from JSON file
function importSingleChat() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async function(e) {
        var file = e.target.files[0];
        if (!file) return;
        
        try {
            var text = await file.text();
            var data = JSON.parse(text);
            
            // Validate the import data
            if (data.exportType !== 'single_chat' || !data.chat) {
                showSnackbar('Invalid chat file format', 'error');
                return;
            }
            
            var importedChat = data.chat;
            
            // Generate a new ID to avoid conflicts
            var newId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            importedChat.id = newId;
            importedChat.title = importedChat.title + ' (imported)';
            // The import-time name is authoritative — drop a serialized
            // provisional flag so the auto-title hook doesn't re-title the
            // chat (losing the '(imported)' marker) on its next run.
            delete importedChat.titleProvisional;
            delete importedChat._titleHookTries;
            importedChat.createdAt = Date.now();
            
            // Add to chats without affecting existing ones
            chats[newId] = importedChat;
            await saveChatsToStorage();
            renderChatList();
            
            showSnackbar('Chat imported successfully', 'success');
        } catch (err) {
            console.error('Import error:', err);
            showSnackbar('Failed to import chat: ' + err.message, 'error');
        }
    };
    input.click();
}
