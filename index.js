// index.js - główny plik backendu
const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const dotenv = require('dotenv');

// Ładowanie zmiennych środowiskowych
dotenv.config();

// Stałe konfiguracyjne
const PORT = process.env.PORT || 3000;
const DEVELOPER_API_KEY = process.env.DEVELOPER_API_KEY; // Główny klucz API developera (stały)
const MDBLIST_API_BASE = 'https://mdblist.com/api';

// Inicjalizacja Express
const app = express();
app.use(cors());
app.use(express.json());

// Utworzenie buildera dodatku Stremio
const builder = new addonBuilder({
    id: 'org.mdblist.importer',
    version: '1.0.0',
    name: 'MDblist Importer',
    description: 'Importuj swoje listy z MDblist do Fusion',
    logo: 'https://mdblist.com/images/logo.png',
    background: 'https://mdblist.com/images/default_backdrop.jpg',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'], // Tylko identyfikatory IMDb
    catalogs: [] // Katalogi będą dodawane dynamicznie
});

// Funkcja pomocnicza do pobierania danych z API MDblist
async function fetchFromMDblist(endpoint, apiKey = DEVELOPER_API_KEY) {
    try {
        const response = await fetch(`${MDBLIST_API_BASE}${endpoint}`, {
            headers: {
                'Accept': 'application/json',
                'apikey': apiKey
            }
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `HTTP Error: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error(`Error fetching from MDblist: ${error.message}`);
        throw error;
    }
}

// Funkcja do pobierania zawartości listy
async function fetchListContent(listSlug) {
    try {
        const data = await fetchFromMDblist(`/lists/${listSlug}/items`);
        return data.items || [];
    } catch (error) {
        console.error(`Error fetching list content for slug ${listSlug}: ${error.message}`);
        return [];
    }
}

// Funkcja do konwersji elementu z MDblist na format metadanych Stremio
function convertToStremioMeta(item) {
    // Określamy typ na podstawie danych
    const type = item.mediatype === 'movie' ? 'movie' : 'series';
    
    // Tworzymy poster URL
    let posterUrl = item.poster || '';
    if (posterUrl && !posterUrl.startsWith('http')) {
        posterUrl = `https://image.tmdb.org/t/p/w500${posterUrl}`;
    }
    
    // Tworzymy backdrop URL
    let backdropUrl = item.backdrop || '';
    if (backdropUrl && !backdropUrl.startsWith('http')) {
        backdropUrl = `https://image.tmdb.org/t/p/original${backdropUrl}`;
    }
    
    // Bazowa struktura metadanych
    const meta = {
        id: `tt${item.imdb || item.id}`, // Preferujemy ID IMDb, ale używamy ID jako fallback
        type,
        name: item.title,
        releaseInfo: item.year ? item.year.toString() : '',
        poster: posterUrl,
        background: backdropUrl,
        posterShape: 'poster',
        imdbRating: item.imdbrating ? parseFloat(item.imdbrating) : null,
    };
    
    // Dodatkowe metadane, jeśli są dostępne
    if (item.description) {
        meta.description = item.description;
    }
    
    if (item.genres && Array.isArray(item.genres)) {
        meta.genres = item.genres;
    }
    
    return meta;
}

// Handler dla manifestu dodatku - dynamicznie generuje katalogi na podstawie parametrów URL
builder.defineManifestHandler(({ query }) => {
    // Odczytaj parametr listSlug z zapytania
    const listSlugParam = query.listSlug || '';
    const listSlugs = listSlugParam.split(',').filter(Boolean);
    
    // Jeśli nie podano żadnych slugów, zwracamy podstawowy manifest
    if (listSlugs.length === 0) {
        return {
            id: 'org.mdblist.importer',
            version: '1.0.0',
            name: 'MDblist Importer',
            description: 'Proszę skonfigurować dodatek, odwiedzając stronę konfiguracyjną',
            logo: 'https://mdblist.com/images/logo.png',
            background: 'https://mdblist.com/images/default_backdrop.jpg',
            resources: ['catalog'],
            types: ['movie', 'series'],
            idPrefixes: ['tt'],
            catalogs: [] // Brak katalogów, bo nie wybrano list
        };
    }
    
    // Tworzymy dynamiczne katalogi na podstawie przekazanych slugów
    const catalogs = [];
    
    // Dodajemy katalog dla filmów
    catalogs.push({
        id: 'mdblist-movies',
        type: 'movie',
        name: 'MDblist - Filmy',
        extra: [
            { name: 'skip' },
            { name: 'search' }
        ]
    });
    
    // Dodajemy katalog dla seriali
    catalogs.push({
        id: 'mdblist-series',
        type: 'series',
        name: 'MDblist - Seriale',
        extra: [
            { name: 'skip' },
            { name: 'search' }
        ]
    });
    
    // Zwracamy zaktualizowany manifest z katalogami
    return {
        ...builder.getManifest(),
        catalogs,
        behaviorHints: {
            configurationRequired: false,
            configurable: true,
            configurationURL: process.env.FRONTEND_URL || 'https://mdblist-importer.pages.dev'
        }
    };
});

// Handler dla katalogu - pobiera i zwraca elementy z wybranych list
builder.defineCatalogHandler(async ({ type, id, extra, query }) => {
    // Odczytaj parametr listSlug z zapytania
    const listSlugParam = query.listSlug || '';
    const listSlugs = listSlugParam.split(',').filter(Boolean);
    
    // Sprawdź, czy podano jakieś slugi
    if (listSlugs.length === 0) {
        return { metas: [] };
    }
    
    // Parametry paginacji
    const skip = parseInt(extra.skip) || 0;
    const limit = 100; // Maksymalna liczba elementów na stronie
    
    // Parametr wyszukiwania
    const search = extra.search || '';
    
    try {
        // Pobieramy zawartość wszystkich list
        const allItemsPromises = listSlugs.map(slug => fetchListContent(slug));
        const allItemsArrays = await Promise.all(allItemsPromises);
        
        // Łączymy wszystkie elementy z różnych list
        let allItems = [].concat(...allItemsArrays);
        
        // Filtrujemy elementy po typie (film lub serial)
        const targetType = type === 'movie' ? 'movie' : 'tv';
        allItems = allItems.filter(item => {
            return (item.mediatype === targetType) || 
                  (targetType === 'movie' && item.mediatype === 'movie') || 
                  (targetType === 'tv' && (item.mediatype === 'tv' || item.mediatype === 'series'));
        });
        
        // Filtrujemy po wyszukiwanej frazie, jeśli podano
        if (search) {
            const searchLower = search.toLowerCase();
            allItems = allItems.filter(item => 
                (item.title && item.title.toLowerCase().includes(searchLower)) ||
                (item.description && item.description.toLowerCase().includes(searchLower))
            );
        }
        
        // Usuwamy duplikaty na podstawie ID
        const uniqueItems = [];
        const uniqueIds = new Set();
        
        for (const item of allItems) {
            const id = item.imdb || item.id;
            if (!uniqueIds.has(id)) {
                uniqueIds.add(id);
                uniqueItems.push(item);
            }
        }
        
        // Paginacja wyników
        const paginatedItems = uniqueItems.slice(skip, skip + limit);
        
        // Konwertujemy dane do formatu Stremio
        const metas = paginatedItems.map(convertToStremioMeta);
        
        return { metas };
    } catch (error) {
        console.error(`Error in catalog handler: ${error.message}`);
        return { metas: [] };
    }
});

// Endpoint proxy dla pobierania list użytkownika
app.post('/api/get-user-lists', async (req, res) => {
    try {
        const { apiKey } = req.body;
        
        if (!apiKey) {
            return res.status(400).json({ error: 'Brak klucza API' });
        }
        
        // Pobieramy listy użytkownika za pomocą jego klucza API
        const response = await fetchFromMDblist('/lists/user', apiKey);
        
        // Zwracamy listy do frontendu
        res.json({ lists: response.lists || [] });
    } catch (error) {
        console.error(`Error fetching user lists: ${error.message}`);
        res.status(500).json({ error: 'Nie udało się pobrać list. Sprawdź swój klucz API.' });
    }
});

// Serwujemy statyczne pliki z katalogu 'public' (strona konfiguracyjna)
app.use(express.static('public'));

// Uruchamiamy serwer na ustandaryzowanym adresie i porcie
const { serveHTTP, publishToCentral } = require('stremio-addon-sdk');

serveHTTP(builder.getInterface(), { port: PORT, static: './public' });

// Publikujemy dodatek do centralnego serwera Stremio (opcjonalnie)
if (process.env.PUBLISH_TO_CENTRAL === 'true') {
    publishToCentral('https://mdblist-importer.pages.dev/manifest.json');
}

console.log(`MDblist Importer addon running at http://localhost:${PORT}`);
