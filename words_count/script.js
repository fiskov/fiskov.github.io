// Элементы DOM
const dropZone = document.getElementById('dropZone');
const treeContainer = document.getElementById('treeContainer');
const treeView = document.getElementById('treeView');
const folderNameEl = document.getElementById('folderName');
const clearBtn = document.getElementById('clearBtn');
const timingInfo = document.getElementById('timingInfo');

// Статистика
let stats = {
    folders: 0,
    files: 0,
    totalSize: 0,
    totalWords: 0
};

// Время обработки
let processingTimes = {
    startTime: null,
    endTime: null
};

// Скорость чтения (слов в минуту)
const READING_SPEED = 150;

// Расширения электронных книг
const EBOOK_EXTENSIONS = ['fb2', 'rtf', 'epub', 'txt', 'docx'];

// Проверка, является ли файл электронной книгой
function isEbook(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return EBOOK_EXTENSIONS.includes(ext);
}

// Подсчёт слов в тексте
function countWords(text, isFb2 = false) {
    let processedText = text;
    
    // Для FB2 файлов удаляем содержимое тегов <binary> и <description>
    if (isFb2) {
        processedText = processedText
            .replace(/<binary[^>]*>[\s\S]*?<\/binary>/gi, ' ')
            .replace(/<description[^>]*>[\s\S]*?<\/description>/gi, ' ');
    }
    
    // Удаляем HTML теги, XML теги и специальные символы
    const cleanText = processedText
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
async function readFileAsText(file, encoding = 'UTF-8') {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file, encoding);
    });
}

// Проверка, является ли текст валидным UTF-8
function isValidUTF8(text) {
    // Проверяем наличие символов замены (�), которые появляются при неправильной кодировке
    const replacementChar = '\uFFFD';
    const replacementCount = (text.match(new RegExp(replacementChar, 'g')) || []).length;
    
    // Если более 5% символов - это символы замены, считаем что кодировка неверная
    return replacementCount < text.length * 0.05;
}

// Подсчёт слов в файле электронной книги
async function countWordsInEbook(file) {
    try {
        const ext = file.name.split('.').pop().toLowerCase();
        const isFb2 = ext === 'fb2';
        let text;
        
        // Для txt файлов пробуем сначала UTF-8, потом cp1251
        if (ext === 'txt') {
            text = await readFileAsText(file, 'UTF-8');
            
            // Если UTF-8 не подходит, пробуем cp1251 (windows-1251)
            if (!isValidUTF8(text)) {
                text = await readFileAsText(file, 'windows-1251');
            }
        } else {
            // Для остальных форматов используем UTF-8
            text = await readFileAsText(file, 'UTF-8');
        }
        
        return countWords(text, isFb2);
    } catch (error) {
        console.error('Error counting words:', error);
        return null;
    }
}

// Проверка, является ли файл zip-архивом
function isZipFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ext === 'zip';
}

// Обработка zip-файла и подсчёт слов во вложенных книгах
async function processZipFile(file) {
    try {
        const zip = await JSZip.loadAsync(file);
        let totalWords = 0;
        const ebookFiles = [];
        
        // Находим все файлы электронных книг в архиве
        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && isEbook(relativePath)) {
                ebookFiles.push({ path: relativePath, entry: zipEntry });
            }
        });
        
        // Подсчитываем слова в каждой книге
        for (const { path, entry } of ebookFiles) {
            try {
                const ext = path.split('.').pop().toLowerCase();
                const isFb2 = ext === 'fb2';
                let text;
                
                if (ext === 'txt') {
                    // Пробуем UTF-8
                    text = await entry.async('text');
                    
                    // Если не подходит, пробуем cp1251
                    if (!isValidUTF8(text)) {
                        const arrayBuffer = await entry.async('arraybuffer');
                        const decoder = new TextDecoder('windows-1251');
                        text = decoder.decode(arrayBuffer);
                    }
                } else {
                    text = await entry.async('text');
                }
                
                const words = countWords(text, isFb2);
                if (words > 0) {
                    totalWords += words;
                }
            } catch (error) {
                console.error(`Error processing ${path}:`, error);
            }
        }
        
        return totalWords > 0 ? totalWords : null;
    } catch (error) {
        console.error('Error processing zip file:', error);
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
    processingTimes.startTime = new Date();
    stats = { folders: 0, files: 0, totalSize: 0, totalWords: 0 };
    
    folderNameEl.textContent = `📁 ${directoryEntry.name}`;
    treeView.innerHTML = '';
    timingInfo.innerHTML = '';
    
    const tree = await buildTreeFromEntry(directoryEntry);
    
    // Подсчитываем суммы слов для всех папок
    stats.totalWords = calculateFolderWordCount(tree);
    
    renderTree(tree, treeView);
    
    processingTimes.endTime = new Date();
    
    addStats();
    displayTimingInfo();
    treeContainer.classList.remove('hidden');
}

// Обработка файлов через input
async function processFilesArray(files) {
    processingTimes.startTime = new Date();
    stats = { folders: 0, files: 0, totalSize: 0, totalWords: 0 };
    
    // Получаем имя корневой папки
    const rootPath = files[0].webkitRelativePath.split('/')[0];
    folderNameEl.textContent = `📁 ${rootPath}`;
    
    treeView.innerHTML = '';
    timingInfo.innerHTML = '';
    
    const tree = await buildTreeFromFiles(files);
    
    // Подсчитываем суммы слов для всех папок
    stats.totalWords = calculateFolderWordCount(tree);
    
    renderTree(tree, treeView);
    
    processingTimes.endTime = new Date();
    
    addStats();
    displayTimingInfo();
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
            
            // Подсчёт слов для zip-архивов
            if (isZipFile(entry.name)) {
                node.wordCount = await processZipFile(file);
            }
            // Подсчёт слов для электронных книг
            else if (isEbook(entry.name)) {
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
                    if (isZipFile(part)) {
                        wordCountPromises.push(
                            processZipFile(file).then(count => {
                                child.wordCount = count;
                            })
                        );
                    } else if (isEbook(part)) {
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

// Подсчёт суммы слов в папке (рекурсивно)
function calculateFolderWordCount(node) {
    if (node.type === 'file') {
        return node.wordCount || 0;
    }
    
    if (node.type === 'folder' && node.children) {
        let totalWords = 0;
        node.children.forEach(child => {
            totalWords += calculateFolderWordCount(child);
        });
        node.wordCount = totalWords;
        return totalWords;
    }
    
    return 0;
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
    
    // Добавляем количество слов для папок и файлов
    if (node.wordCount !== undefined && node.wordCount !== null && node.wordCount > 0) {
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

// Форматирование даты и времени
function formatDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Форматирование времени чтения
function formatReadingTime(words) {
    const minutes = words / READING_SPEED;
    const totalHours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    
    // Если больше 24 часов, разбиваем на дни
    if (totalHours >= 24) {
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;
        
        if (hours > 0) {
            return `${days} сут ${hours} ч`;
        } else {
            return `${days} сут`;
        }
    } else if (totalHours > 0) {
        return `${totalHours} ч ${mins} мин`;
    } else if (mins > 0) {
        return `${mins} мин`;
    } else {
        return `< 1 мин`;
    }
}

// Отображение информации о времени обработки
function displayTimingInfo() {
    if (!processingTimes.startTime || !processingTimes.endTime) return;
    
    const duration = (processingTimes.endTime - processingTimes.startTime) / 1000;
    const readingTime = stats.totalWords > 0 ? formatReadingTime(stats.totalWords) : '-';
    
    timingInfo.innerHTML = `
        <div><span class="timing-label">Начало обработки:</span> <span class="timing-value">${formatDateTime(processingTimes.startTime)}</span></div>
        <div><span class="timing-label">Окончание обработки:</span> <span class="timing-value">${formatDateTime(processingTimes.endTime)}</span></div>
        <div><span class="timing-label">Затраченное время:</span> <span class="timing-value">${duration.toFixed(2)} сек</span></div>
        <div><span class="timing-label">Всего слов:</span> <span class="timing-value">${stats.totalWords.toLocaleString()} (время чтения: ${readingTime} при 150 слов/мин)</span></div>
    `;
}

// Очистка
clearBtn.addEventListener('click', () => {
    treeContainer.classList.add('hidden');
    treeView.innerHTML = '';
    timingInfo.innerHTML = '';
    stats = { folders: 0, files: 0, totalSize: 0, totalWords: 0 };
    processingTimes = { startTime: null, endTime: null };
});