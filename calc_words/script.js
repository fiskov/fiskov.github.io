// Элементы DOM
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const progressContainer = document.getElementById('progress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const resultsContainer = document.getElementById('results');
const resultsBody = document.getElementById('resultsBody');
const totalBooksEl = document.getElementById('totalBooks');
const totalWordsEl = document.getElementById('totalWords');
const resetBtn = document.getElementById('resetBtn');

// Обработчики событий для drag & drop
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(file => {
        const name = file.name.toLowerCase();
        return name.endsWith('.zip') || name.endsWith('.fb2') ||
               name.endsWith('.epub') || name.endsWith('.mobi') ||
               name.endsWith('.docx') || name.endsWith('.rtf') ||
               name.endsWith('.txt');
    });
    if (files.length > 0) {
        processFiles(files);
    }
});

fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files).filter(file => {
        const name = file.name.toLowerCase();
        return name.endsWith('.zip') || name.endsWith('.fb2') ||
               name.endsWith('.epub') || name.endsWith('.mobi') ||
               name.endsWith('.docx') || name.endsWith('.rtf') ||
               name.endsWith('.txt');
    });
    if (files.length > 0) {
        processFiles(files);
    }
});

resetBtn.addEventListener('click', () => {
    resultsContainer.style.display = 'none';
    dropZone.style.display = 'block';
    resultsBody.innerHTML = '';
    fileInput.value = '';
});

// Функция подсчета слов в тексте
function countWords(text) {
    // Удаляем все HTML/XML теги
    const withoutTags = text.replace(/<[^>]*>/g, ' ');
    // Удаляем специальные символы и оставляем только буквы, цифры и пробелы
    const cleaned = withoutTags.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    // Разбиваем на слова и фильтруем пустые строки
    const words = cleaned.split(/\s+/).filter(word => word.length > 0);
    return words.length;
}

// Функция извлечения текста из FB2
function extractTextFromFB2(content) {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, 'text/xml');
        
        // Проверяем на ошибки парсинга
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            console.error('Ошибка парсинга FB2:', parserError.textContent);
            return '';
        }
        
        // Извлекаем текст из body
        const body = xmlDoc.querySelector('body');
        if (body) {
            return body.textContent || '';
        }
        
        // Если body не найден, берем весь текст
        return xmlDoc.documentElement.textContent || '';
    } catch (error) {
        console.error('Ошибка обработки FB2:', error);
        return '';
    }
}

// Функция извлечения текста из EPUB
async function extractTextFromEPUB(zipFile) {
    try {
        let allText = '';
        
        // EPUB - это ZIP архив с HTML/XHTML файлами
        const files = Object.keys(zipFile.files);
        
        for (const fileName of files) {
            // Ищем HTML/XHTML файлы в EPUB
            if (fileName.match(/\.(html|xhtml|htm)$/i) && !fileName.includes('nav.xhtml')) {
                const file = zipFile.files[fileName];
                const content = await file.async('text');
                
                const parser = new DOMParser();
                const doc = parser.parseFromString(content, 'text/html');
                
                // Удаляем скрипты и стили
                const scripts = doc.querySelectorAll('script, style');
                scripts.forEach(el => el.remove());
                
                // Извлекаем текст из body
                const body = doc.querySelector('body');
                if (body) {
                    allText += ' ' + body.textContent;
                }
            }
        }
        
        return allText;
    } catch (error) {
        console.error('Ошибка обработки EPUB:', error);
        return '';
    }
}

// Функция извлечения текста из TXT
async function extractTextFromTXT(file) {
    try {
        const content = await file.text();
        return content;
    } catch (error) {
        console.error('Ошибка обработки TXT:', error);
        return '';
    }
}

// Функция извлечения текста из DOCX
async function extractTextFromDOCX(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        return result.value;
    } catch (error) {
        console.error('Ошибка обработки DOCX:', error);
        return '';
    }
}

// Функция извлечения текста из RTF
async function extractTextFromRTF(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const rtfDoc = new RTFJS.Document(arrayBuffer);
        const htmlElements = await rtfDoc.render();
        
        // Извлекаем текст из HTML элементов
        let text = '';
        for (const element of htmlElements) {
            if (element.textContent) {
                text += element.textContent + ' ';
            }
        }
        return text;
    } catch (error) {
        console.error('Ошибка обработки RTF:', error);
        return '';
    }
}

// Функция извлечения текста из MOBI
async function extractTextFromMOBI(file) {
    try {
        // MOBI - это формат Amazon Kindle, который содержит HTML-подобную разметку
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Ищем текстовые записи в MOBI файле
        // MOBI содержит PalmDOC сжатие, но мы попробуем извлечь текст напрямую
        let text = '';
        
        // Конвертируем в строку и ищем текстовый контент
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const content = decoder.decode(uint8Array);
        
        // Удаляем бинарные данные и извлекаем текст
        // MOBI часто содержит HTML теги
        const withoutBinary = content.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
        text = withoutBinary;
        
        return text;
    } catch (error) {
        console.error('Ошибка обработки MOBI:', error);
        return '';
    }
}

// Функция обработки одного файла книги
async function processBookFile(file, archiveName = null) {
    const fileName = file.name;
    const format = fileName.split('.').pop().toUpperCase();
    
    let text = '';
    let wordCount = 0;
    
    try {
        if (format === 'FB2') {
            const content = await file.text();
            text = extractTextFromFB2(content);
            wordCount = countWords(text);
        } else if (format === 'EPUB') {
            const epubData = await file.arrayBuffer();
            const epubZip = await JSZip.loadAsync(epubData);
            text = await extractTextFromEPUB(epubZip);
            wordCount = countWords(text);
        } else if (format === 'TXT') {
            text = await extractTextFromTXT(file);
            wordCount = countWords(text);
        } else if (format === 'DOCX') {
            text = await extractTextFromDOCX(file);
            wordCount = countWords(text);
        } else if (format === 'RTF') {
            text = await extractTextFromRTF(file);
            wordCount = countWords(text);
        } else if (format === 'MOBI') {
            text = await extractTextFromMOBI(file);
            wordCount = countWords(text);
        }
        
        if (wordCount > 0) {
            return {
                archive: archiveName || 'Прямая загрузка',
                book: fileName,
                format: format,
                words: wordCount
            };
        }
    } catch (error) {
        console.error(`Ошибка обработки файла ${fileName}:`, error);
    }
    
    return null;
}

// Основная функция обработки файлов
async function processFiles(files) {
    dropZone.style.display = 'none';
    progressContainer.style.display = 'block';
    resultsContainer.style.display = 'none';
    
    const results = [];
    let totalBooks = 0;
    let totalWords = 0;
    let processedFiles = 0;
    
    for (const file of files) {
        try {
            const fileName = file.name.toLowerCase();
            
            // Проверяем, является ли файл ZIP-архивом
            if (fileName.endsWith('.zip')) {
                progressText.textContent = `Обработка архива: ${file.name}...`;
                
                const zip = await JSZip.loadAsync(file);
                const bookFiles = Object.keys(zip.files).filter(fileName => {
                    const lower = fileName.toLowerCase();
                    return (lower.endsWith('.fb2') || lower.endsWith('.epub') ||
                            lower.endsWith('.mobi') || lower.endsWith('.txt') ||
                            lower.endsWith('.docx') || lower.endsWith('.rtf')) &&
                           !fileName.startsWith('__MACOSX') &&
                           !fileName.includes('/.') &&
                           !zip.files[fileName].dir;
                });
                
                for (const bookFileName of bookFiles) {
                    try {
                        const bookFile = zip.files[bookFileName];
                        const bookName = bookFileName.split('/').pop();
                        
                        progressText.textContent = `Обработка: ${bookName}...`;
                        
                        // Создаем File объект из данных архива
                        const fileData = await bookFile.async('blob');
                        const extractedFile = new File([fileData], bookName);
                        
                        const result = await processBookFile(extractedFile, file.name);
                        if (result) {
                            results.push(result);
                            totalBooks++;
                            totalWords += result.words;
                        }
                    } catch (error) {
                        console.error(`Ошибка обработки книги ${bookFileName}:`, error);
                    }
                }
            } else {
                // Обрабатываем файл напрямую (не из архива)
                progressText.textContent = `Обработка: ${file.name}...`;
                
                const result = await processBookFile(file);
                if (result) {
                    results.push(result);
                    totalBooks++;
                    totalWords += result.words;
                }
            }
            
            processedFiles++;
            const progress = (processedFiles / files.length) * 100;
            progressBar.style.width = progress + '%';
            
        } catch (error) {
            console.error(`Ошибка обработки файла ${file.name}:`, error);
        }
    }
    
    // Отображение результатов
    displayResults(results, totalBooks, totalWords);
}

// Функция отображения результатов
function displayResults(results, totalBooks, totalWords) {
    progressContainer.style.display = 'none';
    resultsContainer.style.display = 'block';
    
    totalBooksEl.textContent = totalBooks;
    totalWordsEl.textContent = totalWords.toLocaleString('ru-RU');
    
    resultsBody.innerHTML = '';
    
    // Сортируем результаты по количеству слов (по убыванию)
    results.sort((a, b) => b.words - a.words);
    
    results.forEach(result => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${result.archive}</td>
            <td>${result.book}</td>
            <td>${result.format}</td>
            <td><strong>${result.words.toLocaleString('ru-RU')}</strong></td>
        `;
        resultsBody.appendChild(row);
    });
    
    if (results.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="4" style="text-align: center; color: #999;">
                Книги не найдены или не удалось обработать файлы
            </td>
        `;
        resultsBody.appendChild(row);
    }
}