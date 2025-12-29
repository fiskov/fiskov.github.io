// Элементы DOM
const dropZone = document.getElementById('dropZone');
const treeContainer = document.getElementById('treeContainer');
const treeView = document.getElementById('treeView');
const folderNameEl = document.getElementById('folderName');
const clearBtn = document.getElementById('clearBtn');

// Статистика
let stats = {
    folders: 0,
    files: 0,
    totalSize: 0
};

// Расширения электронных книг
const EBOOK_EXTENSIONS = ['fb2', 'rtf', 'epub', 'txt', 'docx'];

// Проверка, является ли файл электронной книгой
function isEbook(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return EBOOK_EXTENSIONS.includes(ext);
}

// Подсчёт слов в тексте
function countWords(text) {
    // Удаляем HTML теги, XML теги и специальные символы
    const cleanText = text
        .replace(/<[^>]*>/g, ' ') // Удаляем HTML/XML теги
        .replace(/[^\p{L}\p{N}\s]/gu, ' ') // Оставляем только буквы, цифры и пробелы
        .replace(/\s+/g, ' ') // Заменяем множественные пробелы на один
        .trim();
    
    if (!cleanText) return 0;
    
    // Разбиваем на слова и считаем
    const words = cleanText.split(/\s+/).filter(word => word.length > 0);
    return words.length;
}

// Чтение содержимого файла как текста
async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file, 'UTF-8');
    });
}

// Подсчёт слов в файле электронной книги
async function countWordsInEbook(file) {
    try {
        const text = await readFileAsText(file);
        return countWords(text);
    } catch (error) {
        console.error('Error counting words:', error);
        return null;
    }
}

// Обработчики drag & drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const items = e.dataTransfer.items;
    
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i].webkitGetAsEntry();
            if (item && item.isDirectory) {
                await processDirectory(item);
                break; // Обрабатываем только первую папку
            }
        }
    }
});

// Клик для выбора папки
dropZone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    
    input.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            processFilesArray(files);
        }
    });
    
    input.click();
});

// Обработка папки через drag & drop
async function processDirectory(directoryEntry) {
    stats = { folders: 0, files: 0, totalSize: 0 };
    
    folderNameEl.textContent = `📁 ${directoryEntry.name}`;
    treeView.innerHTML = '';
    
    const tree = await buildTreeFromEntry(directoryEntry);
    renderTree(tree, treeView);
    
    addStats();
    treeContainer.classList.remove('hidden');
}

// Обработка файлов через input
async function processFilesArray(files) {
    stats = { folders: 0, files: 0, totalSize: 0 };
    
    // Получаем имя корневой папки
    const rootPath = files[0].webkitRelativePath.split('/')[0];
    folderNameEl.textContent = `📁 ${rootPath}`;
    
    const tree = await buildTreeFromFiles(files);
    treeView.innerHTML = '';
    renderTree(tree, treeView);
    
    addStats();
    treeContainer.classList.remove('hidden');
}

// Построение дерева из Entry API
async function buildTreeFromEntry(entry, path = '') {
    const node = {
        name: entry.name,
        type: entry.isDirectory ? 'folder' : 'file',
        children: [],
        path: path + '/' + entry.name
    };
    
    if (entry.isDirectory) {
        stats.folders++;
        const reader = entry.createReader();
        const entries = await readAllEntries(reader);
        
        for (const childEntry of entries) {
            const childNode = await buildTreeFromEntry(childEntry, node.path);
            node.children.push(childNode);
        }
        
        // Сортировка: папки сначала, потом файлы
        node.children.sort((a, b) => {
            if (a.type === b.type) {
                return a.name.localeCompare(b.name);
            }
            return a.type === 'folder' ? -1 : 1;
        });
    } else {
        stats.files++;
        // Получаем размер файла
        const file = await getFileFromEntry(entry);
        if (file) {
            node.size = file.size;
            stats.totalSize += file.size;
            
            // Подсчёт слов для электронных книг
            if (isEbook(entry.name)) {
                node.wordCount = await countWordsInEbook(file);
            }
        }
    }
    
    return node;
}

// Чтение всех записей из директории
function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
        const entries = [];
        
        function readEntries() {
            reader.readEntries((results) => {
                if (results.length === 0) {
                    resolve(entries);
                } else {
                    entries.push(...results);
                    readEntries();
                }
            }, reject);
        }
        
        readEntries();
    });
}

// Получение файла из Entry
function getFileFromEntry(fileEntry) {
    return new Promise((resolve) => {
        fileEntry.file(resolve, () => resolve(null));
    });
}

// Построение дерева из массива файлов
async function buildTreeFromFiles(files) {
    const root = {
        name: files[0].webkitRelativePath.split('/')[0],
        type: 'folder',
        children: [],
        path: ''
    };
    
    stats.folders = 1;
    
    // Создаём промисы для подсчёта слов
    const wordCountPromises = [];
    
    files.forEach(file => {
        const parts = file.webkitRelativePath.split('/').slice(1);
        let current = root;
        
        parts.forEach((part, index) => {
            const isFile = index === parts.length - 1;
            
            let child = current.children.find(c => c.name === part);
            
            if (!child) {
                child = {
                    name: part,
                    type: isFile ? 'file' : 'folder',
                    children: [],
                    path: parts.slice(0, index + 1).join('/'),
                    file: isFile ? file : null
                };
                
                if (isFile) {
                    child.size = file.size;
                    stats.files++;
                    stats.totalSize += file.size;
                    
                    // Добавляем промис для подсчёта слов
                    if (isEbook(part)) {
                        wordCountPromises.push(
                            countWordsInEbook(file).then(count => {
                                child.wordCount = count;
                            })
                        );
                    }
                } else {
                    stats.folders++;
                }
                
                current.children.push(child);
            }
            
            current = child;
        });
    });
    
    // Ждём завершения всех подсчётов слов
    await Promise.all(wordCountPromises);
    
    // Сортировка
    sortTree(root);
    
    return root;
}

// Рекурсивная сортировка дерева
function sortTree(node) {
    if (node.children && node.children.length > 0) {
        node.children.sort((a, b) => {
            if (a.type === b.type) {
                return a.name.localeCompare(b.name);
            }
            return a.type === 'folder' ? -1 : 1;
        });
        
        node.children.forEach(child => sortTree(child));
    }
}

// Отрисовка дерева
function renderTree(node, container, level = 0) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${level * 20}px`;
    
    const content = document.createElement('div');
    content.className = 'tree-item-content';
    
    if (node.type === 'folder' && node.children.length > 0) {
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle expanded';
        toggle.textContent = '▶';
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle.classList.toggle('expanded');
            item.classList.toggle('collapsed');
        });
        content.appendChild(toggle);
    } else if (node.type === 'folder') {
        const spacer = document.createElement('span');
        spacer.style.width = '16px';
        spacer.style.display = 'inline-block';
        content.appendChild(spacer);
    }
    
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.type === 'folder' ? '📁' : getFileIcon(node.name);
    content.appendChild(icon);
    
    const name = document.createElement('span');
    name.className = `tree-name tree-${node.type}`;
    
    // Добавляем количество слов для электронных книг
    if (node.type === 'file' && node.wordCount !== undefined && node.wordCount !== null) {
        name.textContent = `[${node.wordCount.toLocaleString()}] ${node.name}`;
    } else {
        name.textContent = node.name;
    }
    
    if (node.type === 'file' && node.size !== undefined) {
        name.textContent += ` (${formatSize(node.size)})`;
    }
    
    content.appendChild(name);
    item.appendChild(content);
    
    if (node.children && node.children.length > 0) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        
        node.children.forEach(child => {
            renderTree(child, childrenContainer, level + 1);
        });
        
        item.appendChild(childrenContainer);
    }
    
    container.appendChild(item);
}

// Получение иконки для файла
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        'js': '📜',
        'ts': '📘',
        'json': '📋',
        'html': '🌐',
        'css': '🎨',
        'md': '📝',
        'txt': '📄',
        'pdf': '📕',
        'jpg': '🖼️',
        'jpeg': '🖼️',
        'png': '🖼️',
        'gif': '🖼️',
        'svg': '🎭',
        'mp4': '🎬',
        'mp3': '🎵',
        'zip': '📦',
        'rar': '📦',
        'py': '🐍',
        'java': '☕',
        'cpp': '⚙️',
        'c': '⚙️',
        'go': '🔷',
        'rs': '🦀',
        'php': '🐘',
        'rb': '💎',
        'sh': '🔧',
        'yml': '⚙️',
        'yaml': '⚙️',
        'xml': '📰',
        'sql': '🗄️'
    };
    
    return icons[ext] || '📄';
}

// Форматирование размера файла
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Добавление статистики
function addStats() {
    const existingStats = treeView.parentElement.querySelector('.stats');
    if (existingStats) {
        existingStats.remove();
    }
    
    const statsDiv = document.createElement('div');
    statsDiv.className = 'stats';
    statsDiv.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">📁 Папок:</span>
            <span class="stat-value">${stats.folders}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">📄 Файлов:</span>
            <span class="stat-value">${stats.files}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">💾 Общий размер:</span>
            <span class="stat-value">${formatSize(stats.totalSize)}</span>
        </div>
    `;
    
    treeView.parentElement.appendChild(statsDiv);
}

// Очистка
clearBtn.addEventListener('click', () => {
    treeContainer.classList.add('hidden');
    treeView.innerHTML = '';
    stats = { folders: 0, files: 0, totalSize: 0 };
});