/* ============================================================
   Klassenkonferenzen planen – script.js
   Refactoring-Hinweise (Funktionalität unverändert):
   - Utility-Funktionen (escapeHtml, csvEscape, shuffle) extrahiert,
     um Codeduplikate zu vermeiden und XSS/CSV-Injection abzusichern.
   - Doppelter Initialisierungs-Block in DOMContentLoaded entfernt
     (vorher wurde beim Start alles zweimal geladen).
   - Die beiden DOMContentLoaded-Listener wurden zu einem
     zusammengeführt.
   - Tote/ungenutzte Funktion (setHasAny) entfernt.
   - Klar in Abschnitte gegliedert (State, Utilities, CSV-Import,
     Tabellen-UI, Auswahl, Planung, Export, Init).

   Planungsalgorithmus (Abschnitt 8) überarbeitet:
   - "Most constrained first": Klassen werden primär nach ihrem Lehrer-
     Puffer (verfügbare Lehrkräfte minus Mindestanzahl) sortiert, nicht
     mehr nur nach Fächer-Punkten. Knappe Klassen kommen zuerst dran.
   - Best-Fit statt First-Fit bei der Slot-Wahl: es werden alle passenden
     Slots gesammelt und der am wenigsten gefüllte gewählt (bessere
     Lastverteilung, mehr Puffer für später kommende Klassen).
   - Reparatur-Durchgang: Klassen, die im ersten Anlauf keinen Slot
     gefunden haben, werden per Tausch mit einer bereits platzierten,
     verdrängbaren Klasse doch noch untergebracht, sofern möglich.
   - Zufalls-Tie-Break beim Sortieren: statt `Math.random() - 0.5`
     direkt im Comparator (inkonsistenter Comparator, verzerrt/
     Engine-abhängig) wird vorher gemischt und danach stabil sortiert.
   - Schutz gegen Division durch 0 bei der Raumvergabe, falls keine
     Räume konfiguriert sind.
   ============================================================ */

/* ---------------------------------------------------------------
   1) Globaler State
   --------------------------------------------------------------- */
const state = {
  klassenMap: {},
  lehrerSet: new Set(),
  faecherSet: new Set(),
  unterrichtLoaded: false,
  klassenleiterLoaded: false,
  aktuellerPlan: null,
  anwesendeLehrer: new Set(),
  bevorzugteFaecher: new Set(),
  raeume: [], // Ein Raum pro paralleler Konferenz
  pausen: [],
};

// Merkt sich die aktuell eingestellte Sortierung je Tabelle, damit sie nach
// dem Löschen von Zeilen (oder anderen Neu-Renderings) erhalten bleibt.
const tableSortState = { unterricht: null, klassenleiter: null };

/* ---------------------------------------------------------------
   2) Utility-Funktionen
   --------------------------------------------------------------- */

// HTML-Escaping: verhindert, dass Klassen-/Lehrer-/Fachnamen aus den
// importierten CSV-Dateien als HTML interpretiert werden (XSS-Schutz)
// und sorgt dafür, dass Anführungszeichen in Attributen nicht die
// Tabellenstruktur zerstören.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// CSV-Feld-Escaping für Export/Speichern: verdoppelt Anführungszeichen
// (RFC 4180) und neutralisiert Werte, die mit =, +, -, @ beginnen
// (Schutz vor CSV-/Formel-Injection beim Öffnen in Excel & Co.).
function csvEscape(value) {
  let v = String(value ?? '');
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

// Fisher-Yates-Shuffle (in-place), zentral statt mehrfach dupliziert.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const saveToLocalStorage = (key, value) => localStorage.setItem(key, value);
const getFromLocalStorage = (key) => localStorage.getItem(key) || '';

// Einfacher CSV-Parser für das Format mit Kommas als Trennzeichen
const parseCSVLine = (line) => {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
};

function enableDragAndDrop(dropZoneId, inputId) {
  const dropZone = document.getElementById(dropZoneId);
  const fileInput = document.getElementById(inputId);

  if (!dropZone || !fileInput) {
    console.warn(`Element nicht gefunden: ${dropZoneId} oder ${inputId}`);
    return;
  }

  ['dragenter', 'dragover'].forEach(event => {
    dropZone.addEventListener(event, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.backgroundColor = '#e6f3ff';
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach(event => {
    dropZone.addEventListener(event, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.backgroundColor = '#ffffff';
    });
  });

  dropZone.addEventListener('drop', e => {
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function addStatusMessage(message, isError = false, isWarning = false) {
  const csvMessageDiv = document.getElementById('csvMessage');
  if (!csvMessageDiv) {
    console.error("Element mit ID 'csvMessage' wurde nicht gefunden.");
    return;
  }

  const now = new Date();
  const timestamp = `${now.getDate().toString().padStart(2, '0')}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  const messageWithTimestamp = `[${timestamp}] ${message}`;

  const storedMessages = getFromLocalStorage('csvMessages') ? JSON.parse(getFromLocalStorage('csvMessages')) : [];
  storedMessages.unshift({ text: messageWithTimestamp, isError, isWarning });
  saveToLocalStorage('csvMessages', JSON.stringify(storedMessages));

  renderStatusMessages(storedMessages, csvMessageDiv);
}

function renderStatusMessages(messages, csvMessageDiv) {
  csvMessageDiv.innerHTML = messages
    .map(msg => `<p class="${msg.isWarning ? 'warning' : msg.isError ? 'error' : 'success'}">${escapeHtml(msg.text)}</p>`)
    .join('');
  csvMessageDiv.scrollTop = csvMessageDiv.scrollHeight;
}

const createTableHTML = (headers, bodyId, tableKey) => `
  <table class="csv-table">
    <thead><tr>
      <th class="select-col"><input type="checkbox" class="selectAllRows" data-table="${tableKey}" title="Alle auswählen"></th>
      ${headers.map(h => `<th class="sortable">${h}</th>`).join('')}
      <th class="action-col">Aktion</th>
    </tr></thead>
    <tbody id="${bodyId}"></tbody>
  </table>
`;

/* ---------------------------------------------------------------
   3) Plan- & Auswahl-Persistenz
   --------------------------------------------------------------- */

function speicherePlan() {
  if (state.aktuellerPlan) {
    localStorage.setItem('planDaten', JSON.stringify({
      aktuellerPlan: state.aktuellerPlan,
      anwesendeLehrer: Array.from(state.anwesendeLehrer),
      // bevorzugteFaecher wird bewusst NICHT hier gespeichert – einzige Quelle
      // dafür ist 'planungsoptionen' (siehe speicherePlanungsoptionen), um
      // eine doppelte, potenziell widersprüchliche Speicherung zu vermeiden.
      raeume: state.raeume,
    }));
  }
}

function speichereAuswahl() {
  const selectedKlassen = Array.from(document.querySelectorAll('.klasseCheckbox:checked')).map(cb => cb.value);
  const selectedLehrer = Array.from(document.querySelectorAll('.lehrerCheckbox:checked')).map(cb => cb.value);
  const jahrgangEinträge = {};

  document.querySelectorAll('.jahrgangInput').forEach(input => {
    const klasse = input.closest('.jahrgang-input').dataset.klasse;
    const value = input.value.trim();
    if (value && !isNaN(value) && parseInt(value) >= 1 && parseInt(value) <= 13) {
      jahrgangEinträge[klasse] = value;
      if (state.klassenMap[klasse]) {
        state.klassenMap[klasse].manuellerJahrgang = value;
      }
    }
  });

  state.anwesendeLehrer = new Set(selectedLehrer);
  saveToLocalStorage('auswahlDaten', JSON.stringify({ selectedKlassen, selectedLehrer, jahrgangEinträge }));
}

function ladeAuswahl() {
  const gespeicherteAuswahl = getFromLocalStorage('auswahlDaten');
  let selectedKlassen = [];
  let selectedLehrer = [];
  let jahrgangEinträge = {};

  if (gespeicherteAuswahl) {
    try {
      const auswahl = JSON.parse(gespeicherteAuswahl);
      selectedKlassen = auswahl.selectedKlassen.filter(k => state.klassenMap[k]);
      selectedLehrer = auswahl.selectedLehrer.filter(l => state.lehrerSet.has(l));
      jahrgangEinträge = Object.fromEntries(
        Object.entries(auswahl.jahrgangEinträge || {}).filter(([klasse]) => state.klassenMap[klasse])
      );
    } catch (e) {
      console.error('Fehler beim Parsen der gespeicherten Auswahl-Daten:', e);
      localStorage.removeItem('auswahlDaten');
    }
  }

  if (selectedKlassen.length === 0 && Object.keys(state.klassenMap).length > 0) {
    selectedKlassen = Object.keys(state.klassenMap);
  }
  if (selectedLehrer.length === 0 && state.lehrerSet.size > 0) {
    selectedLehrer = Array.from(state.lehrerSet);
  }

  document.querySelectorAll('.klasseCheckbox').forEach(cb => {
    cb.checked = state.klassenMap[cb.value] ? selectedKlassen.includes(cb.value) : false;
  });

  document.querySelectorAll('.lehrerCheckbox').forEach(cb => {
    cb.checked = state.lehrerSet.has(cb.value) ? selectedLehrer.includes(cb.value) : false;
  });

  Object.entries(jahrgangEinträge).forEach(([klasse, jahrgang]) => {
    if (state.klassenMap[klasse]) {
      state.klassenMap[klasse].manuellerJahrgang = jahrgang;
      const input = document.querySelector(`.jahrgang-input[data-klasse="${klasse}"] .jahrgangInput`);
      if (input) input.value = jahrgang;
    }
  });

  state.anwesendeLehrer = new Set(selectedLehrer);
  speichereAuswahl();
}

/* ---------------------------------------------------------------
   4) CSV-Import & Datenmanagement
   --------------------------------------------------------------- */

async function ladeGespeicherteCSV(changedFile = null) {
  const neueKlassen = new Set();
  const neueLehrer = new Set();
  const neueFaecher = new Set();

  state.aktuellerPlan = null;
  state.anwesendeLehrer = new Set();
  state.bevorzugteFaecher = new Set();

  // --- Unterrichts-CSV ---
  const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
  if (unterrichtCSV) {
    Object.values(state.klassenMap).forEach(kl => {
      kl.lehrerSet.clear();
      kl.lehrerFaecher.clear();
    });

    const lines = unterrichtCSV.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      if (changedFile === 'unterricht') addStatusMessage('Unterrichts-Datei enthält keine Datenzeilen.', true);
      state.unterrichtLoaded = false;
    } else {
      const headerColumns = parseCSVLine(lines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const fachIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fach');
      const lehrkraftIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'lehrkraft');
      const fachgruppeIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fachgruppe');

      if (klasseIndex === -1 || fachIndex === -1 || lehrkraftIndex === -1) {
        if (changedFile === 'unterricht') {
          const missingColumns = [];
          if (klasseIndex === -1) missingColumns.push('Klasse');
          if (fachIndex === -1) missingColumns.push('Fach');
          if (lehrkraftIndex === -1) missingColumns.push('Lehrkraft');
          addStatusMessage(`Fehler beim Laden der Unterrichts-Datei: Spalten ${missingColumns.join(', ')} nicht gefunden.`, true);
        }
        state.unterrichtLoaded = false;
      } else {
        let validRows = 0;
        for (let i = 1; i < lines.length; i++) {
          const columns = parseCSVLine(lines[i]);
          const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
          const fach = columns[fachIndex] ? columns[fachIndex].replace(/"/g, '').trim() : '';
          const lehrkraft = columns[lehrkraftIndex] ? columns[lehrkraftIndex].replace(/"/g, '').trim() : '';

          if (!klasse || !fach || !lehrkraft) {
            if (changedFile === 'unterricht') {
              addStatusMessage(`Ungültige Daten in Unterrichts-CSV, Zeile ${i + 1}: Klasse, Fach oder Lehrkraft fehlt oder ist ungültig.`, false, true);
            }
            continue;
          }

          neueFaecher.add(fach);
          neueKlassen.add(klasse);
          neueLehrer.add(lehrkraft);

          if (!state.klassenMap[klasse]) {
            state.klassenMap[klasse] = { name: klasse, kl: null, lehrerSet: new Set(), lehrerFaecher: new Map(), manuellerJahrgang: null };
          }
          state.klassenMap[klasse].lehrerSet.add(lehrkraft);
          if (!state.klassenMap[klasse].lehrerFaecher.has(lehrkraft)) {
            state.klassenMap[klasse].lehrerFaecher.set(lehrkraft, new Set());
          }
          state.klassenMap[klasse].lehrerFaecher.get(lehrkraft).add(fach);
          validRows++;
        }
        state.unterrichtLoaded = validRows > 0;
        if (changedFile === 'unterricht') {
          if (validRows > 0) {
            addStatusMessage('Unterricht erfolgreich geladen.');
          } else {
            addStatusMessage('Unterrichts-Datei enthält keine gültigen Datenzeilen.', true);
          }
        }
      }
    }
  } else {
    state.unterrichtLoaded = false;
    if (changedFile === 'unterricht') addStatusMessage('Keine Unterrichts-CSV-Daten vorhanden.', true);
  }

  // --- Klassenleiter-CSV ---
  const klassenleiterCSV = getFromLocalStorage('klassenleiterCSV');
  if (klassenleiterCSV) {
    Object.values(state.klassenMap).forEach(kl => { kl.kl = null; });

    const lines = klassenleiterCSV.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      if (changedFile === 'klassenleiter') addStatusMessage('Klassenleiter-Datei enthält keine Datenzeilen.', true);
      state.klassenleiterLoaded = false;
    } else {
      const headerColumns = parseCSVLine(lines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const klassenleitungIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klassenleitung');

      if (klasseIndex === -1 || klassenleitungIndex === -1) {
        if (changedFile === 'klassenleiter') {
          const missingColumns = [];
          if (klasseIndex === -1) missingColumns.push('Klasse');
          if (klassenleitungIndex === -1) missingColumns.push('Klassenleitung');
          addStatusMessage(`Fehler beim Laden der Klassenleiter-Datei: Spalten ${missingColumns.join(', ')} nicht gefunden.`, true);
        }
        state.klassenleiterLoaded = false;
      } else {
        const klassenGesehen = new Set();
        const doppelteKlassen = new Set();
        let validRows = 0;

        for (let i = 1; i < lines.length; i++) {
          const columns = parseCSVLine(lines[i]);
          const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
          const klassenleitung = columns[klassenleitungIndex] ? columns[klassenleitungIndex].replace(/"/g, '').trim() : '';

          if (!klasse || !klassenleitung) {
            if (changedFile === 'klassenleiter') {
              addStatusMessage(`Ungültige Daten in Klassenleiter-Datei, Zeile ${i + 1}: Klasse oder Klassenleitung fehlt oder ist ungültig.`, false, true);
            }
            continue;
          }

          if (klassenGesehen.has(klasse)) doppelteKlassen.add(klasse);
          else klassenGesehen.add(klasse);

          neueKlassen.add(klasse);
          neueLehrer.add(klassenleitung);

          if (!state.klassenMap[klasse]) {
            state.klassenMap[klasse] = { name: klasse, kl: null, lehrerSet: new Set(), lehrerFaecher: new Map(), manuellerJahrgang: null };
          }
          state.klassenMap[klasse].kl = klassenleitung;
          validRows++;
        }

        if (doppelteKlassen.size > 0 && changedFile === 'klassenleiter') {
          addStatusMessage(`Folgende Klassen kommen in der Klassenleiter-Datei mehrfach vor: ${Array.from(doppelteKlassen).join(', ')}. Nur die letzte Zuordnung wird verwendet.`, false, true);
        }

        state.klassenleiterLoaded = validRows > 0;
        if (changedFile === 'klassenleiter') {
          if (validRows > 0) addStatusMessage('Klassenleiter erfolgreich geladen.');
          else addStatusMessage('Klassenleiter enthält keine gültigen Datenzeilen.', true);
        }
      }
    }
  } else {
    state.klassenleiterLoaded = false;
    if (changedFile === 'klassenleiter') addStatusMessage('Keine Klassenleiter-Daten vorhanden.', true);
  }

  // Bereinige state.klassenMap: entferne Klassen, die nicht mehr in den CSVs existieren
  Object.keys(state.klassenMap).forEach(klasse => {
    if (!neueKlassen.has(klasse)) delete state.klassenMap[klasse];
  });

  state.lehrerSet = new Set(neueLehrer);
  state.faecherSet = new Set(neueFaecher);

  // Lade gespeicherte Plan-Daten (inkl. Räume)
  const gespeichertePlanDaten = getFromLocalStorage('planDaten');
  if (gespeichertePlanDaten) {
    try {
      const planDaten = JSON.parse(gespeichertePlanDaten);
      state.aktuellerPlan = planDaten.aktuellerPlan;
      state.anwesendeLehrer = new Set(planDaten.anwesendeLehrer || []);
      state.raeume = planDaten.raeume || [];
    } catch (e) {
      console.error('Fehler beim Parsen der gespeicherten Plan-Daten:', e);
      localStorage.removeItem('planDaten');
      if (changedFile) addStatusMessage('Fehler beim Laden gespeicherter Plan-Daten.', true);
    }
  }

  state.anwesendeLehrer = new Set([...state.anwesendeLehrer].filter(l => state.lehrerSet.has(l)));

  updateUI();
  ladeAuswahl();
}

/* ---------------------------------------------------------------
   5) CSV-Bearbeitungs-Tabellen (UI)
   --------------------------------------------------------------- */

async function zeigeCSVBearbeitung() {
  const loadingIndicator = document.getElementById('loadingIndicator');
  if (loadingIndicator) loadingIndicator.classList.add('active');

  const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
  const klassenleiterCSV = getFromLocalStorage('klassenleiterCSV');
  const csvTablesSection = document.getElementById('csvTablesSection');
  const klassenleiterCSVSection = document.getElementById('klassenleiterCSVSection');

  const unterrichtTable = document.getElementById('unterrichtCSVTable');
  const addUnterrichtRow = document.getElementById('addUnterrichtRow');
  const saveUnterrichtCSV = document.getElementById('saveUnterrichtCSV');

  if (unterrichtTable) {
    if (csvTablesSection) csvTablesSection.classList.remove('hidden');

    if (unterrichtCSV && state.unterrichtLoaded) {
      const unterrichtLines = unterrichtCSV.split('\n').filter(line => line.trim());
      if (unterrichtLines.length < 2) return;

      const headerColumns = parseCSVLine(unterrichtLines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const fachIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fach');
      const lehrkraftIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'lehrkraft');
      const fachgruppeIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fachgruppe');

      if (klasseIndex === -1 || fachIndex === -1 || lehrkraftIndex === -1) {
        unterrichtTable.innerHTML = '<p class="no-data-hint">Fehler: Benötigte Spalten (Klasse, Fach, Lehrkraft) nicht gefunden.</p>';
        return;
      }

      const headers = ['Klasse', 'Fach', 'Lehrkraft'];
      const hasFachgruppe = fachgruppeIndex !== -1;
      if (hasFachgruppe) headers.splice(1, 0, 'Fachgruppe');

      unterrichtTable.innerHTML = createTableHTML(headers, 'unterrichtCSVBody', 'unterricht');
      const unterrichtBody = document.getElementById('unterrichtCSVBody');

      const processedData = [];
      for (let i = 1; i < unterrichtLines.length; i++) {
        const columns = parseCSVLine(unterrichtLines[i]);
        const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
        const fach = columns[fachIndex] ? columns[fachIndex].replace(/"/g, '').trim() : '';
        const lehrkraft = columns[lehrkraftIndex] ? columns[lehrkraftIndex].replace(/"/g, '').trim() : '';
        const fachgruppe = fachgruppeIndex !== -1 ? (columns[fachgruppeIndex] ? columns[fachgruppeIndex].replace(/"/g, '').trim() : '') : '';

        if (klasse && fach && lehrkraft) {
          processedData.push({ klasse, fachgruppe, fach, lehrkraft, originalIndex: i });
        }
      }
      processedData.sort((a, b) => a.originalIndex - b.originalIndex);

      unterrichtBody.innerHTML = processedData.map(data => {
        const rowFields = hasFachgruppe ? ['klasse', 'fachgruppe', 'fach', 'lehrkraft'] : ['klasse', 'fach', 'lehrkraft'];
        return `
    <tr data-row-id="${data.originalIndex}">
      <td class="select-col"><input type="checkbox" class="rowSelect" data-row="${data.originalIndex}" data-table="unterricht"></td>
      ${rowFields.map(field => `<td><input type="text" value="${escapeHtml(data[field] || '')}" data-row="${data.originalIndex}" data-field="${field}" placeholder="${field.charAt(0).toUpperCase() + field.slice(1)}"></td>`).join('')}
      <td class="action-col"><button class="delete-row-btn" data-row="${data.originalIndex}" data-table="unterricht">Löschen</button></td>
    </tr>
  `;
      }).join('');

      if (addUnterrichtRow) addUnterrichtRow.style.display = 'inline-block';
      if (saveUnterrichtCSV) saveUnterrichtCSV.style.display = 'inline-block';
      updateRowCountHint('unterricht', processedData.length);

      const sortableFields = hasFachgruppe ? ['klasse', 'fachgruppe', 'fach', 'lehrkraft'] : ['klasse', 'fach', 'lehrkraft'];
      addSortListeners('unterrichtCSVBody', sortableFields, 'unterricht');
      if (tableSortState.unterricht) {
        sortTableRows('unterrichtCSVBody', tableSortState.unterricht.field, tableSortState.unterricht.direction);
      }
    } else {
      unterrichtTable.innerHTML = '<p class="no-data-hint">Bitte laden Sie die Unterrichts-Daten hoch, um die Daten anzuzeigen.</p>';
      if (addUnterrichtRow) addUnterrichtRow.style.display = 'none';
      if (saveUnterrichtCSV) saveUnterrichtCSV.style.display = 'none';
      updateRowCountHint('unterricht', 0);
    }
  }

  const klassenleiterTable = document.getElementById('klassenleiterCSVTable');
  const addKlassenleiterRow = document.getElementById('addKlassenleiterRow');
  const saveKlassenleiterCSV = document.getElementById('saveKlassenleiterCSV');

  if (klassenleiterTable) {
    if (klassenleiterCSVSection) klassenleiterCSVSection.classList.remove('hidden');

    if (klassenleiterCSV && state.klassenleiterLoaded) {
      klassenleiterTable.innerHTML = createTableHTML(['Klasse', 'Klassenleitung'], 'klassenleiterCSVBody', 'klassenleiter');
      const klassenleiterBody = document.getElementById('klassenleiterCSVBody');
      const klassenleiterLines = klassenleiterCSV.split('\n').filter(line => line.trim());
      if (klassenleiterLines.length < 2) return;

      const headerColumns = parseCSVLine(klassenleiterLines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const klassenleitungIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klassenleitung');

      if (klasseIndex === -1 || klassenleitungIndex === -1) {
        klassenleiterTable.innerHTML = '<p class="no-data-hint">Fehler: Benötigte Spalten (Klasse, Klassenleitung) nicht gefunden.</p>';
        return;
      }

      const processedKlassenleiterData = [];
      for (let i = 1; i < klassenleiterLines.length; i++) {
        const columns = parseCSVLine(klassenleiterLines[i]);
        const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
        const klassenleitung = columns[klassenleitungIndex] ? columns[klassenleitungIndex].replace(/"/g, '').trim() : '';
        if (klasse && klassenleitung) processedKlassenleiterData.push({ klasse, klassenleitung, originalIndex: i });
      }
      processedKlassenleiterData.sort((a, b) => a.originalIndex - b.originalIndex);

      klassenleiterBody.innerHTML = processedKlassenleiterData.map(data => `
    <tr data-row-id="${data.originalIndex}">
      <td class="select-col"><input type="checkbox" class="rowSelect" data-row="${data.originalIndex}" data-table="klassenleiter"></td>
      <td><input type="text" value="${escapeHtml(data.klasse)}" data-row="${data.originalIndex}" data-field="klasse" placeholder="Klasse"></td>
      <td><input type="text" value="${escapeHtml(data.klassenleitung)}" data-row="${data.originalIndex}" data-field="klassenleitung" placeholder="Klassenleitung"></td>
      <td class="action-col"><button class="delete-row-btn" data-row="${data.originalIndex}" data-table="klassenleiter">Löschen</button></td>
    </tr>
  `).join('');

      if (addKlassenleiterRow) addKlassenleiterRow.style.display = 'inline-block';
      if (saveKlassenleiterCSV) saveKlassenleiterCSV.style.display = 'inline-block';
      updateRowCountHint('klassenleiter', processedKlassenleiterData.length);

      addSortListeners('klassenleiterCSVBody', ['klasse', 'klassenleitung'], 'klassenleiter');
      if (tableSortState.klassenleiter) {
        sortTableRows('klassenleiterCSVBody', tableSortState.klassenleiter.field, tableSortState.klassenleiter.direction);
      }
    } else {
      klassenleiterTable.innerHTML = '<p class="no-data-hint">Bitte laden Sie die Klassenleiter-Daten hoch, um die Daten anzuzeigen.</p>';
      if (addKlassenleiterRow) addKlassenleiterRow.style.display = 'none';
      if (saveKlassenleiterCSV) saveKlassenleiterCSV.style.display = 'none';
      updateRowCountHint('klassenleiter', 0);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  if (loadingIndicator) loadingIndicator.classList.remove('active');

  addDeleteRowListeners();
  attachRowCheckboxListeners();
}

function updateRowCountHint(table, count) {
  const el = document.getElementById(table === 'unterricht' ? 'unterrichtRowCount' : 'klassenleiterRowCount');
  if (el) el.textContent = count > 0 ? `(${count} Zeile${count === 1 ? '' : 'n'})` : '';
}

function attachRowCheckboxListeners() {
  document.querySelectorAll('.selectAllRows').forEach(cb => {
    cb.onchange = () => {
      const table = cb.dataset.table;
      document.querySelectorAll(`.rowSelect[data-table="${table}"]`).forEach(rowCb => { rowCb.checked = cb.checked; });
      updateDeleteSelectedButtonState(table);
    };
  });
  document.querySelectorAll('.rowSelect').forEach(cb => {
    cb.onchange = () => updateDeleteSelectedButtonState(cb.dataset.table);
  });
  updateDeleteSelectedButtonState('unterricht');
  updateDeleteSelectedButtonState('klassenleiter');
}

function updateDeleteSelectedButtonState(table) {
  const btn = document.getElementById(table === 'unterricht' ? 'deleteSelectedUnterrichtRows' : 'deleteSelectedKlassenleiterRows');
  if (!btn) return;
  btn.disabled = document.querySelectorAll(`.rowSelect[data-table="${table}"]:checked`).length === 0;
}

// Sortiert die Zeilen eines Tabellenkörpers nach einem Feld/einer Richtung.
function sortTableRows(bodyId, field, direction) {
  const tbody = document.getElementById(bodyId);
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));

  rows.sort((a, b) => {
    const aValue = a.querySelector(`input[data-field="${field}"]`)?.value.toLowerCase() || '';
    const bValue = b.querySelector(`input[data-field="${field}"]`)?.value.toLowerCase() || '';
    return direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
  });

  tbody.innerHTML = '';
  rows.forEach(row => tbody.appendChild(row));

  addDeleteRowListeners();
  attachRowCheckboxListeners();
}

function addSortListeners(bodyId, sortableFields, tableKey) {
  const table = document.querySelector(`#${bodyId}`).closest('table');
  const headers = table.querySelectorAll('th.sortable');

  const applyArrow = () => {
    headers.forEach(h => h.innerHTML = h.innerHTML.replace(/ [↑↓]/, ''));
    const current = tableSortState[tableKey];
    if (!current) return;
    const idx = sortableFields.indexOf(current.field);
    if (idx > -1 && headers[idx]) headers[idx].innerHTML += current.direction === 'asc' ? ' ↑' : ' ↓';
  };
  applyArrow();

  headers.forEach((header, index) => {
    if (index >= sortableFields.length) return;
    const field = sortableFields[index];
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      const previous = tableSortState[tableKey];
      const direction = (previous && previous.field === field && previous.direction === 'asc') ? 'desc' : 'asc';
      tableSortState[tableKey] = { field, direction };
      sortTableRows(bodyId, field, direction);
      applyArrow();
    });
  });
}

function addDeleteRowListeners() {
  document.querySelectorAll('.delete-row-btn').forEach(button => {
    // Button klonen statt neuen Listener zu addieren -> verhindert doppelte Listener
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);
    newButton.addEventListener('click', (e) => {
      const rowId = parseInt(e.target.dataset.row);
      const table = e.target.dataset.table;
      deleteRow(rowId, table);
    });
  });
}

async function deleteRow(rowId, table) {
  const storageKey = table === 'unterricht' ? 'unterrichtCSV' : 'klassenleiterCSV';
  const csv = getFromLocalStorage(storageKey);
  if (!csv) return;

  const lines = csv.split('\n').filter(line => line.trim());
  lines.splice(rowId, 1);
  saveToLocalStorage(storageKey, lines.join('\n'));

  await ladeGespeicherteCSV();
  await zeigeCSVBearbeitung();
  alert(`Zeile ${rowId + 1} aus ${table === 'unterricht' ? 'Unterrichts-CSV' : 'Klassenleiter-CSV'} gelöscht.`);
}

async function deleteSelectedRows(table) {
  const checkboxes = Array.from(document.querySelectorAll(`.rowSelect[data-table="${table}"]:checked`));
  if (checkboxes.length === 0) return;

  const rowIds = checkboxes.map(cb => parseInt(cb.dataset.row, 10));
  const confirmMessage = `${rowIds.length} Zeile${rowIds.length === 1 ? '' : 'n'} aus ${table === 'unterricht' ? 'Unterrichts-CSV' : 'Klassenleiter-CSV'} wirklich löschen?`;
  if (!confirm(confirmMessage)) return;

  const storageKey = table === 'unterricht' ? 'unterrichtCSV' : 'klassenleiterCSV';
  const csv = getFromLocalStorage(storageKey);
  if (!csv) return;

  const idSet = new Set(rowIds);
  const lines = csv.split('\n').filter(line => line.trim());
  const remainingLines = lines.filter((line, index) => index === 0 || !idSet.has(index));
  saveToLocalStorage(storageKey, remainingLines.join('\n'));

  await ladeGespeicherteCSV();
  await zeigeCSVBearbeitung();
  alert(`${rowIds.length} Zeile${rowIds.length === 1 ? '' : 'n'} gelöscht.`);
}

function addTableRow(tableBodyId, fields, rowId) {
  const tableBody = document.getElementById(tableBodyId);
  if (!tableBody) return;
  const tableKey = tableBodyId.includes('unterricht') ? 'unterricht' : 'klassenleiter';
  tableBody.innerHTML += `
      <tr data-row-id="${rowId}">
        <td class="select-col"><input type="checkbox" class="rowSelect" data-row="${rowId}" data-table="${tableKey}"></td>
        ${fields.map(field => `<td><input type="text" value="" data-row="${rowId}" data-field="${field}" placeholder="${field.charAt(0).toUpperCase() + field.slice(1)}"></td>`).join('')}
        <td class="action-col"><button class="delete-row-btn" data-row="${rowId}" data-table="${tableKey}">Löschen</button></td>
      </tr>
    `;
  addDeleteRowListeners();
  attachRowCheckboxListeners();
}

function saveCSV(tableBodyId, storageKey, fields, alertMessage) {
  const rows = Array.from(document.querySelectorAll(`#${tableBodyId} tr`)).sort(
    (a, b) => parseInt(a.dataset.rowId) - parseInt(b.dataset.rowId)
  );

  // Überprüfung auf doppelte Klassen (nur für Klassenleiter-Tabelle)
  if (storageKey === 'klassenleiterCSV') {
    const klassenGesehen = new Set();
    const doppelteKlassen = new Set();

    rows.forEach(row => {
      const klasseInput = row.querySelector('input[data-field="klasse"]');
      if (!klasseInput) return;
      const klasse = klasseInput.value.trim();
      if (klasse) {
        if (klassenGesehen.has(klasse)) doppelteKlassen.add(klasse);
        else klassenGesehen.add(klasse);
      }
    });

    if (doppelteKlassen.size > 0) {
      const warningMessage = `Folgende Klassen kommen in der Klassenleiter-Tabelle mehrfach vor: ${Array.from(doppelteKlassen).join(', ')}. Bitte korrigieren Sie die Eingaben, bevor Sie speichern.`;
      addStatusMessage(warningMessage, false, true);
      alert(warningMessage);
      return;
    }
  }

  const csvLines = rows
    .map(row => {
      const rowData = fields.map(field => {
        const input = row.querySelector(`input[data-field="${field}"]`);
        return csvEscape(input ? input.value.trim() : '');
      });
      const line = rowData.join(',');
      return rowData.some(val => val !== '""') ? line : null;
    })
    .filter(line => line);

  let header;
  if (storageKey === 'unterrichtCSV') {
    header = fields.includes('fachgruppe') ? '"Klasse","Fachgruppe","Fach","Lehrkraft"' : '"Klasse","Fach","Lehrkraft"';
  } else {
    header = '"Klasse","Klassenleitung"';
  }
  const finalCSV = csvLines.length > 0 ? [header, ...csvLines].join('\n') : header;
  saveToLocalStorage(storageKey, finalCSV);

  ladeGespeicherteCSV().then(() => {
    zeigeCSVBearbeitung().then(() => {
      updateUI();
      ladeAuswahl();
      addStatusMessage(alertMessage);
      alert(alertMessage);
    });
  }).catch(error => {
    const errorMessage = `Fehler beim Speichern der ${storageKey === 'unterrichtCSV' ? 'Unterrichts' : 'Klassenleiter'}-Daten: ${error.message}`;
    console.error('saveCSV: Fehler beim Aktualisieren nach Speichern:', error);
    addStatusMessage(errorMessage, true);
    alert(errorMessage);
  });
}

/* ---------------------------------------------------------------
   6) Allgemeine UI (Tabs, Klassen/Lehrer/Fächer-Listen, Räume)
   --------------------------------------------------------------- */

function activateTab(tabId) {
  document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  document.querySelector(`.tab-button[data-tab="${tabId}"]`)?.classList.add('active');
  document.getElementById(tabId)?.classList.add('active');
}

function toggleJahrgangInputs() {
  const einerProJahrgang = document.getElementById('einerProJahrgang');
  if (!einerProJahrgang) return;
  const showInputs = einerProJahrgang.checked;
  document.querySelectorAll('.jahrgang-input').forEach(span => {
    if (!span.dataset.klasse.match(/^(\d+)/)) {
      span.style.display = showInputs ? 'inline-block' : 'none';
    }
  });
}

function updateUI() {
  const optionen = document.getElementById('optionen');
  if (!optionen) {
    console.error("Element mit ID 'optionen' wurde nicht gefunden.");
    return;
  }
  optionen.style.display = 'block';

  const planungTab = document.getElementById('planungTab');
  if (planungTab) planungTab.classList.toggle('hidden', !state.unterrichtLoaded);

  const kCont = document.getElementById('klassenContainer');
  if (kCont) {
    const klassen = Object.keys(state.klassenMap).sort();
    kCont.innerHTML = klassen.length > 0
      ? klassen.map(k => {
        const hatZahl = k.match(/^(\d+)/);
        const jahrgang = state.klassenMap[k].manuellerJahrgang || '';
        return `
            <label>
              <input type="checkbox" class="klasseCheckbox" value="${escapeHtml(k)}" checked> ${escapeHtml(k)}
              <span class="jahrgang-input" data-klasse="${escapeHtml(k)}" style="display:${hatZahl ? 'none' : 'inline-block'};">
                <input type="number" class="jahrgangInput" min="1" max="13" value="${escapeHtml(jahrgang)}" placeholder="Jahrgang">
              </span>
            </label>`;
      }).join('')
      : '<p>Keine Klassen verfügbar. Bitte importieren Sie die Dateien.</p>';
  }

  const lCont = document.getElementById('lehrerContainer');
  if (lCont) {
    lCont.innerHTML = state.lehrerSet.size > 0
      ? Array.from(state.lehrerSet).sort().map(l => `<label><input type="checkbox" class="lehrerCheckbox" value="${escapeHtml(l)}" checked> ${escapeHtml(l)}</label>`).join('')
      : '<p>Keine Lehrer verfügbar. Bitte importieren Sie die Dateien.</p>';
  }

  ladeAuswahl();
  ladePlanungsoptionen();
  updateFaecherUI();
  updateRaeumeUI();

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.style.display = state.aktuellerPlan ? 'block' : 'none';
  const exportLehrerBtn = document.getElementById('exportLehrerBtn');
  if (exportLehrerBtn) exportLehrerBtn.style.display = state.aktuellerPlan ? 'block' : 'none';

  toggleJahrgangInputs();
  zeigeCSVBearbeitung();
}

function updateRaeumeUI() {
  const maxKlassenProSlot = parseInt(document.getElementById('maxKlassenProSlot')?.value) || 5;
  const raeumeInputs = document.getElementById('raeumeInputs');
  if (!raeumeInputs) return;

  state.raeume.length = maxKlassenProSlot; // kürzt oder erweitert das Array
  for (let i = 0; i < maxKlassenProSlot; i++) {
    if (state.raeume[i] === undefined) state.raeume[i] = '';
  }

  raeumeInputs.innerHTML = '';
  for (let i = 0; i < maxKlassenProSlot; i++) {
    const raumInput = document.createElement('input');
    raumInput.type = 'text';
    raumInput.placeholder = `Raum ${i + 1}`;
    raumInput.value = state.raeume[i] || '';
    raumInput.addEventListener('input', () => {
      state.raeume[i] = raumInput.value;
      speicherePlanungsoptionen();
    });
    raeumeInputs.appendChild(raumInput);
    if (i < maxKlassenProSlot - 1) raeumeInputs.appendChild(document.createTextNode(' '));
  }
}

function updateFaecherUI() {
  const fCont = document.getElementById('faecherContainer');
  if (!fCont) return;
  fCont.innerHTML = Array.from(state.faecherSet).sort().map(f => `
      <label><input type="checkbox" class="fachCheckbox" value="${escapeHtml(f)}" ${state.bevorzugteFaecher.has(f) ? 'checked' : ''}> ${escapeHtml(f)}</label>
    `).join('');
}

function selectAllKlassen() {
  document.querySelectorAll('.klasseCheckbox').forEach(cb => { if (state.klassenMap[cb.value]) cb.checked = true; });
  speichereAuswahl();
  addStatusMessage('Alle Klassen ausgewählt.');
}

function selectAllLehrer() {
  document.querySelectorAll('.lehrerCheckbox').forEach(cb => { if (state.lehrerSet.has(cb.value)) cb.checked = true; });
  speichereAuswahl();
  addStatusMessage('Alle Lehrer ausgewählt.');
}

/* ---------------------------------------------------------------
   7) Planungsoptionen
   --------------------------------------------------------------- */

function speicherePlanungsoptionen() {
  const optionen = {
    maxSlots: document.getElementById('maxSlots')?.value,
    maxKlassenProSlot: document.getElementById('maxKlassenProSlot')?.value,
    anwesendQuote: document.getElementById('anwesendQuote')?.value,
    klassenleiterPflicht: document.getElementById('klassenleiterPflicht')?.checked,
    einerProJahrgang: document.getElementById('einerProJahrgang')?.checked,
    nurAnwesendeFuerQuote: document.getElementById('nurAnwesendeFuerQuote')?.checked,
    ignoreQuote: document.getElementById('ignoreQuote')?.checked,
    erzwingePackung: document.getElementById('erzwingePackung')?.checked,
    startZeit: document.getElementById('startZeit')?.value,
    dauerMinuten: document.getElementById('dauerMinuten')?.value,
    pausen: state.pausen || [],
    bevorzugteFaecher: Array.from(state.bevorzugteFaecher),
    raeume: state.raeume,
  };
  saveToLocalStorage('planungsoptionen', JSON.stringify(optionen));
}

function ladePlanungsoptionen() {
  const gespeicherteOptionen = getFromLocalStorage('planungsoptionen');
  if (!gespeicherteOptionen) return;

  const optionen = JSON.parse(gespeicherteOptionen);
  const maxSlots = document.getElementById('maxSlots');
  if (maxSlots) maxSlots.value = optionen.maxSlots || 0;
  const maxKlassenProSlot = document.getElementById('maxKlassenProSlot');
  if (maxKlassenProSlot) maxKlassenProSlot.value = optionen.maxKlassenProSlot || 5;
  const anwesendQuote = document.getElementById('anwesendQuote');
  if (anwesendQuote) anwesendQuote.value = optionen.anwesendQuote || 0;
  const klassenleiterPflicht = document.getElementById('klassenleiterPflicht');
  if (klassenleiterPflicht) klassenleiterPflicht.checked = optionen.klassenleiterPflicht !== undefined ? optionen.klassenleiterPflicht : true;
  const einerProJahrgang = document.getElementById('einerProJahrgang');
  if (einerProJahrgang) einerProJahrgang.checked = optionen.einerProJahrgang !== undefined ? optionen.einerProJahrgang : true;
  const nurAnwesendeFuerQuote = document.getElementById('nurAnwesendeFuerQuote');
  if (nurAnwesendeFuerQuote) nurAnwesendeFuerQuote.checked = optionen.nurAnwesendeFuerQuote === true;
  const ignoreQuote = document.getElementById('ignoreQuote');
  if (ignoreQuote) ignoreQuote.checked = optionen.ignoreQuote === true;
  const erzwingePackung = document.getElementById('erzwingePackung');
  if (erzwingePackung) erzwingePackung.checked = optionen.erzwingePackung === true;
  const startZeit = document.getElementById('startZeit');
  if (startZeit) startZeit.value = optionen.startZeit || '13:00';
  const dauerMinuten = document.getElementById('dauerMinuten');
  if (dauerMinuten) dauerMinuten.value = optionen.dauerMinuten || '20';
  state.pausen = optionen.pausen || [];
  renderPausenUI();

  // Gegen state.faecherSet filtern, falls sich die Fächerliste seit dem letzten
  // Speichern geändert hat – verhindert, dass veraltete Fächer in der Planung
  // wirken, obwohl sie in der Checkbox-Liste gar nicht mehr auftauchen.
  state.bevorzugteFaecher = new Set([...(optionen.bevorzugteFaecher || [])].filter(f => state.faecherSet.has(f)));
  state.raeume = optionen.raeume || [];
  updateRaeumeUI();
}

/* ---------------------------------------------------------------
   8) Planungsalgorithmus (verbessert)
   --------------------------------------------------------------- */

// Zählt, wie viele der bevorzugten Fächer ein Lehrer/eine Klasse abdeckt
// (statt einer reinen ja/nein-Prüfung), damit die Priorisierung auch bei
// mehreren ausgewählten Fächern noch eine spürbare, abgestufte Wirkung hat.
function countMatchingFaecher(setA, bevorzugt) {
  let count = 0;
  for (const elem of bevorzugt) {
    if (setA.has(elem)) count++;
  }
  return count;
}

// Ermittelt, wie "eng" eine Klasse zu verplanen ist: je kleiner der Puffer
// (verfügbare Lehrkräfte minus tatsächlich benötigte Mindestanzahl), desto
// schwieriger wird es später, noch einen passenden Slot zu finden. Wird für
// die "most constrained first"-Priorisierung genutzt.
function berechnePufferKlasse(klasse, anwesendQuote, nurAnwesendeFuerQuote) {
  const verfügbareLehrer = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
  const basis = nurAnwesendeFuerQuote ? verfügbareLehrer.length : klasse.lehrerSet.size;
  const mindAnwesend = Math.ceil(basis * anwesendQuote);
  return verfügbareLehrer.length - mindAnwesend;
}

// Prüft, ob eine Klasse in einen bestimmten Slot passt, und liefert bei
// Erfolg die vorgeschlagene Lehrer-Zuweisung zurück – ohne den Slot bereits
// zu verändern. Wird sowohl bei der Erstplanung als auch bei der Reparatur
// nicht platzierter Klassen verwendet (ein Ort für die Regeln statt
// Codeduplizierung mit Divergenzrisiko).
function pruefeSlot(klasse, slot, plan, belegung, optionen) {
  const { maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, nurAnwesendeFuerQuote, ignoreQuote } = optionen;
  if (plan[slot].length >= maxKlassenProSlot) return null;

  const besetzt = belegung[slot];
  const jahrgang = klasse.manuellerJahrgang || klasse.name.match(/^(\d+)/)?.[1] || null;
  if (einerProJahrgang && jahrgang) {
    const slotJahrgaenge = plan[slot].map(p => p.jahrgang);
    if (slotJahrgaenge.includes(jahrgang)) return null;
  }

  const klassenleiter = klasse.kl;
  const lehrerDerKlasse = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
  const basis = nurAnwesendeFuerQuote ? lehrerDerKlasse.length : klasse.lehrerSet.size;
  const mindAnwesend = Math.ceil(basis * anwesendQuote);
  const verfügbare = lehrerDerKlasse.filter(l => !besetzt.has(l));
  if (!ignoreQuote && verfügbare.length < mindAnwesend) return null;
  if (klassenleiterPflicht && klassenleiter && !verfügbare.includes(klassenleiter)) return null;

  let auszuwählen = [];
  if (klassenleiterPflicht && klassenleiter) auszuwählen.push(klassenleiter);

  // Zuerst mischen, dann stabil nach Fach-Treffern sortieren – ein Zufallswert
  // direkt im Sortier-Vergleich (wie zuvor `Math.random() - 0.5`) verletzt die
  // Anforderungen an einen konsistenten Comparator und kann je nach Engine zu
  // verzerrten Sortierergebnissen führen.
  const restlicheLehrer = shuffle(verfügbare.filter(l => l !== klassenleiter)).sort((a, b) => {
    const treffer_A = countMatchingFaecher(klasse.lehrerFaecher.get(a) || new Set(), state.bevorzugteFaecher);
    const treffer_B = countMatchingFaecher(klasse.lehrerFaecher.get(b) || new Set(), state.bevorzugteFaecher);
    return treffer_B - treffer_A;
  });

  const benötigteLehrer = mindAnwesend - auszuwählen.length;
  auszuwählen = auszuwählen.concat(restlicheLehrer.slice(0, Math.max(benötigteLehrer, 0)));

  return { jahrgang, lehrer: auszuwählen, klassenleiter };
}

// Vergibt den ersten NICHT bereits im Slot verwendeten Raum (nach Namen, nicht
// nach Array-Position!). Positionsbasierte Vergabe (plan[slot].length % ...)
// bricht, sobald Einträge aus der Mitte eines Slots entfernt und neue
// hinzugefügt werden (z. B. im Reparatur-Durchgang) – dabei behalten
// verbleibende Einträge ihren alten Raum, während ein neuer Eintrag anhand
// der neuen (kürzeren) Länge denselben Rauminde bekommen kann -> Duplikat.
function raumFuerSlot(plan, slot, jahrgang, jahrgangRaumMap) {
  if (state.raeume.length === 0) return `Raum ${plan[slot].length + 1}`;
  const belegteRaeumeSlot = new Set(plan[slot].map(e => e.raum));
  // Wenn eine Jahrgangsstufen-Raum-Zuordnung aktiv ist und diese Stufe bereits
  // einen festen Raum hat, diesen verwenden (sofern im Slot noch frei).
  if (jahrgang && jahrgangRaumMap && jahrgangRaumMap.has(jahrgang)) {
    const raum = jahrgangRaumMap.get(jahrgang);
    if (!belegteRaeumeSlot.has(raum)) return raum;
  }
  // Alle Räume, die bereits anderen Jahrgängen zugewiesen sind
  const bereitsVergebeneRaeume = jahrgangRaumMap ? new Set(jahrgangRaumMap.values()) : new Set();
  for (let i = 0; i < state.raeume.length; i++) {
    const raum = state.raeume[i] || `Raum ${i + 1}`;
    if (!belegteRaeumeSlot.has(raum) && !bereitsVergebeneRaeume.has(raum)) {
      if (jahrgang && jahrgangRaumMap && !jahrgangRaumMap.has(jahrgang)) {
        jahrgangRaumMap.set(jahrgang, raum);
      }
      return raum;
    }
  }
  // Fallback: Slot-belegte Räume prüfen, aber bereits vergebene bevorzugen
  for (let i = 0; i < state.raeume.length; i++) {
    const raum = state.raeume[i] || `Raum ${i + 1}`;
    if (!belegteRaeumeSlot.has(raum)) {
      if (jahrgang && jahrgangRaumMap && !jahrgangRaumMap.has(jahrgang)) {
        jahrgangRaumMap.set(jahrgang, raum);
      }
      return raum;
    }
  }
  const raumIndex = plan[slot].length % state.raeume.length;
  const raum = state.raeume[raumIndex] || `Raum ${raumIndex + 1}`;
  if (jahrgang && jahrgangRaumMap && !jahrgangRaumMap.has(jahrgang)) {
    jahrgangRaumMap.set(jahrgang, raum);
  }
  return raum;
}

function versuchePlanung(maxSlots, maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, nurAnwesendeFuerQuote, ignoreQuote, selectedKlassen, erzwingePackung) {
  const belegung = Array(maxSlots).fill().map(() => new Set());
  const plan = Array(maxSlots).fill().map(() => []);
  const warnungen = [];
  const optionen = { maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, nurAnwesendeFuerQuote, ignoreQuote };
  const jahrgangRaumMap = einerProJahrgang ? new Map() : null;
  if (jahrgangRaumMap) {
    // Jahrgänge aller Klassen sammeln, sortieren und Räume in Reihenfolge vergeben
    const jahrgaenge = new Set();
    selectedKlassen.forEach(name => {
      const klasse = state.klassenMap[name];
      const jg = klasse.manuellerJahrgang || klasse.name.match(/^(\d+)/)?.[1] || null;
      if (jg) jahrgaenge.add(jg);
    });
    Array.from(jahrgaenge).sort((a, b) => parseInt(a) - parseInt(b)).forEach((jg, i) => {
      if (i < state.raeume.length) {
        jahrgangRaumMap.set(jg, state.raeume[i] || `Raum ${i + 1}`);
      }
    });
  }

  // Vorab-Berechnung der Priorisierungs-Kriterien je Klasse:
  // 1) Puffer (aufsteigend) – knapp besetzte Klassen zuerst, damit sie nicht
  //    an bereits vollen Slots scheitern.
  // 2) Fächer-Punkte (absteigend) – bei gleichem Puffer weiterhin die
  //    bisherige Priorisierung nach bevorzugten Fächern.
  const pufferScore = new Map();
  const punkteScore = new Map();
  selectedKlassen.forEach(name => {
    const klasse = state.klassenMap[name];
    pufferScore.set(name, berechnePufferKlasse(klasse, anwesendQuote, nurAnwesendeFuerQuote));
    const punkte = Array.from(klasse.lehrerSet).reduce((sum, l) =>
      state.anwesendeLehrer.has(l) ? sum + countMatchingFaecher(klasse.lehrerFaecher.get(l) || new Set(), state.bevorzugteFaecher) : sum, 0);
    punkteScore.set(name, punkte);
  });

  const klassenListe = shuffle(selectedKlassen.map(name => state.klassenMap[name])).sort((a, b) => {
    const pufferDiff = pufferScore.get(a.name) - pufferScore.get(b.name);
    if (pufferDiff !== 0) return pufferDiff;
    return punkteScore.get(b.name) - punkteScore.get(a.name);
  });

  const nichtVerplant = [];

  klassenListe.forEach(klasse => {
    const klassenleiter = klasse.kl;

    if (klassenleiterPflicht) {
      if (!klassenleiter) {
        warnungen.push(`Klasse ${klasse.name} hat keinen Klassenleiter zugeordnet. Klasse wird nicht verplant (Klassenleiterpflicht aktiviert).`);
        return;
      }
      if (!state.anwesendeLehrer.has(klassenleiter) || !klasse.lehrerSet.has(klassenleiter)) {
        warnungen.push(`Klassenleiter ${klassenleiter} der Klasse ${klasse.name} ist nicht anwesend oder unterrichtet nicht in dieser Klasse. Klasse wird nicht verplant (Klassenleiterpflicht aktiviert).`);
        return;
      }
    }

    // Best-Fit statt First-Fit: alle passenden Slots sammeln und den am
    // wenigsten ausgelasteten wählen (Lastverteilung). First-Fit hat
    // tendenziell die zuerst gewürfelten Slots vollgepackt, wodurch später
    // eingeplante (aber eigentlich unkritische) Klassen unnötig oft an
    // vollen Slots scheiterten.
    const kandidaten = [];
    for (const slot of shuffle(Array.from({ length: maxSlots }, (_, i) => i))) {
      const ergebnis = pruefeSlot(klasse, slot, plan, belegung, { ...optionen, ignoreQuote: false });
      if (ergebnis) kandidaten.push({ slot, ...ergebnis });
    }

    if (kandidaten.length === 0) {
      nichtVerplant.push(klasse);
      return;
    }

    kandidaten.sort((a, b) => plan[b.slot].length - plan[a.slot].length);
    const { slot, jahrgang, lehrer } = kandidaten[0];

    plan[slot].push({ klasse: klasse.name, jahrgang, lehrer, klassenleiter, raum: raumFuerSlot(plan, slot, jahrgang, jahrgangRaumMap) });
    lehrer.forEach(l => belegung[slot].add(l));

    if (einerProJahrgang && !jahrgang) {
      warnungen.push(`Klasse ${klasse.name} hat keinen Jahrgang zugewiesen (wird ohne Jahrgangsbeschränkung verplant).`);
    }
  });

  // --- Reparatur-Durchgang für nicht verplante Klassen -----------------
  // Statt eine Klasse endgültig aufzugeben, wird versucht, sie durch einen
  // einfachen Tausch doch noch unterzubringen: Eine bereits platzierte,
  // weniger kritische Klasse aus einem sonst passenden Slot wird probeweise
  // entfernt; passt die unplatzierte Klasse danach hinein UND findet die
  // verdrängte Klasse selbst einen freien Slot, wird der Tausch übernommen.
  // Andernfalls bleibt alles unverändert und die ursprüngliche Warnung
  // bestehen. Das ist ein "eine Ebene tiefer" Local-Search-Schritt, kein
  // vollständiges Backtracking – löst aber einen guten Teil der Fälle, in
  // denen First-Fit-Reihenfolge allein keine Lösung fand.
  nichtVerplant.forEach(klasse => {
    let platziert = false;

    for (let slot = 0; slot < maxSlots && !platziert; slot++) {
      for (const kandidatEntry of [...plan[slot]]) {
        const restSlot = plan[slot].filter(e => e !== kandidatEntry);
        const testPlan = plan.slice();
        testPlan[slot] = restSlot;
        const testBelegung = belegung.map((set, i) => i === slot ? new Set(restSlot.flatMap(e => e.lehrer)) : set);

        const passtRein = pruefeSlot(klasse, slot, testPlan, testBelegung, { ...optionen, ignoreQuote: false });
        if (!passtRein) continue;

        // Prüfen, ob die verdrängte Klasse anderswo unterkommt
        const verdrängteKlasse = state.klassenMap[kandidatEntry.klasse];
        let neuerSlotFürVerdrängte = null;
        for (let alt = 0; alt < maxSlots; alt++) {
          if (alt === slot) continue;
          const ergebnis = pruefeSlot(verdrängteKlasse, alt, plan, belegung, { ...optionen, ignoreQuote: false });
          if (ergebnis) { neuerSlotFürVerdrängte = { alt, ...ergebnis }; break; }
        }
        if (!neuerSlotFürVerdrängte) continue;

        // Tausch übernehmen
        plan[slot] = restSlot;
        belegung[slot] = new Set(restSlot.flatMap(e => e.lehrer));

        plan[slot].push({ klasse: klasse.name, jahrgang: passtRein.jahrgang, lehrer: passtRein.lehrer, klassenleiter: klasse.kl, raum: raumFuerSlot(plan, slot, passtRein.jahrgang, jahrgangRaumMap) });
        passtRein.lehrer.forEach(l => belegung[slot].add(l));

        const { alt, jahrgang: jahrgangAlt, lehrer: lehrerAlt } = neuerSlotFürVerdrängte;
        plan[alt].push({ klasse: verdrängteKlasse.name, jahrgang: jahrgangAlt, lehrer: lehrerAlt, klassenleiter: verdrängteKlasse.kl, raum: raumFuerSlot(plan, alt, jahrgangAlt, jahrgangRaumMap) });
        lehrerAlt.forEach(l => belegung[alt].add(l));

        platziert = true;
        break;
      }
    }

    if (!platziert) {
      warnungen.push(`Für Klasse ${klasse.name} konnte kein passender Slot gefunden werden (auch nach Tauschversuch nicht)${klassenleiterPflicht && klasse.kl ? ` (Klassenleiter ${klasse.kl} anderweitig verplant)` : ''}.`);
    }
  });

  // --- Relaxierter Durchgang für ignoreQuote: Klassen ohne Quotenerfüllung verplanen ---
  // Nur wenn ignoreQuote aktiv ist und Klassen nach dem Reparatur-Durchgang immer noch
  // nicht verplant werden konnten, werden sie ohne Quotenzwang platziert.
  if (ignoreQuote && nichtVerplant.length > 0) {
    const nochNichtVerplant = nichtVerplant.filter(kl =>
      !plan.some(slot => slot.some(e => e.klasse === kl.name))
    );
    nochNichtVerplant.forEach(klasse => {
      const kandidaten = [];
      for (const slot of shuffle(Array.from({ length: maxSlots }, (_, i) => i))) {
        const ergebnis = pruefeSlot(klasse, slot, plan, belegung, optionen);
        if (ergebnis) kandidaten.push({ slot, ...ergebnis });
      }
      if (kandidaten.length === 0) {
        warnungen.push(`Für Klasse ${klasse.name} konnte auch ohne Quotenzwang kein passender Slot gefunden werden.`);
        return;
      }
      kandidaten.sort((a, b) => plan[b.slot].length - plan[a.slot].length);
      const { slot, jahrgang, lehrer } = kandidaten[0];
      plan[slot].push({ klasse: klasse.name, jahrgang, lehrer, klassenleiter: klasse.kl, raum: raumFuerSlot(plan, slot, jahrgang, jahrgangRaumMap) });
      lehrer.forEach(l => belegung[slot].add(l));
      warnungen.push(`Klasse ${klasse.name} wurde ohne Erreichen der Mindestanwesenheitsquote verplant.`);
    });
  }

  // --- Lokale Optimierung: Tausch von Klassen zwischen Slots ---
  // Ein einfacher Durchlauf: für jedes Klassenpaar in unterschiedlichen Slots
  // wird geprüft, ob ein Tausch die Lehrer-Verfügbarkeit verbessert.
  for (let s = 0; s < plan.length; s++) {
    for (let a = 0; a < plan[s].length; a++) {
      const entryA = plan[s][a];
      for (let t = s + 1; t < plan.length; t++) {
        for (let b = 0; b < plan[t].length; b++) {
          const entryB = plan[t][b];

          if (einerProJahrgang) {
            const slotTJgOhneB = plan[t].filter((_, i) => i !== b).map(e => e.jahrgang);
            const slotSJgOhneA = plan[s].filter((_, i) => i !== a).map(e => e.jahrgang);
            if (entryA.jahrgang && slotTJgOhneB.includes(entryA.jahrgang)) continue;
            if (entryB.jahrgang && slotSJgOhneA.includes(entryB.jahrgang)) continue;
          }

          const belegungOhneA = new Set(plan[s].filter((_, i) => i !== a).flatMap(e => e.lehrer));
          const belegungOhneB = new Set(plan[t].filter((_, i) => i !== b).flatMap(e => e.lehrer));
          if (!entryA.lehrer.every(l => !belegungOhneB.has(l)) || !entryB.lehrer.every(l => !belegungOhneA.has(l))) continue;

          [plan[s][a], plan[t][b]] = [entryB, entryA];
          const belegungSNeu = new Set(plan[s].flatMap(e => e.lehrer));
          const belegungTNeu = new Set(plan[t].flatMap(e => e.lehrer));
          if (belegungSNeu.size < belegung[s].size || belegungTNeu.size < belegung[t].size) {
            belegung[s] = belegungSNeu;
            belegung[t] = belegungTNeu;
          } else {
            [plan[s][a], plan[t][b]] = [entryA, entryB];
          }
        }
      }
    }
  }

  // --- Konsolidierung: Klassen aus dünnen Slots in volle verschieben ---
  // Nach der lokalen Optimierung sind Slots oft gleichmäßig gefüllt.
  // Dieser optionale Durchgang verschiebt Klassen aus den dünnsten Slots
  // in die vollsten, um die Packungsdichte zu erhöhen (z.B. 5+5+5+2 statt
  // 4+4+4+4). Die Quote wird dabei stets eingehalten.
  if (erzwingePackung) {
    for (let moved = true; moved; ) {
      moved = false;
      const slotIndices = Array.from({ length: maxSlots }, (_, i) => i)
        .filter(i => plan[i].length > 0)
        .sort((a, b) => (plan[a].length - plan[b].length) || (b - a));
      for (const src of slotIndices) {
        if (plan[src].length >= maxKlassenProSlot) continue;
        const candidates = plan[src].map((entry, idx) => ({ entry, idx }));
        for (const { entry, idx } of candidates) {
          const klasse = state.klassenMap[entry.klasse];
          // Direkter Move: Ziel-Slot hat noch Platz (bevorzugt vordere Slots)
          const targetSlots = slotIndices
            .filter(t => t !== src && plan[t].length < maxKlassenProSlot && plan[t].length >= plan[src].length)
            .sort((a, b) => (plan[b].length - plan[a].length) || (a - b));
          for (const tgt of targetSlots) {
            const ergebnis = pruefeSlot(klasse, tgt, plan, belegung, { ...optionen, ignoreQuote: false });
            if (!ergebnis) continue;
            plan[src].splice(idx, 1);
            belegung[src] = new Set(plan[src].flatMap(e => e.lehrer));
            const neuerEintrag = { klasse: entry.klasse, jahrgang: ergebnis.jahrgang, lehrer: ergebnis.lehrer, klassenleiter: entry.klassenleiter, raum: raumFuerSlot(plan, tgt, ergebnis.jahrgang, jahrgangRaumMap) };
            plan[tgt].push(neuerEintrag);
            ergebnis.lehrer.forEach(l => belegung[tgt].add(l));
            moved = true;
            break;
          }
          if (moved) break;
          // Swap-Fallback: Tausch mit einer Klasse aus einem volleren Slot (bevorzugt vordere)
          const swapTargets = slotIndices
            .filter(t => t !== src && plan[t].length > plan[src].length)
            .sort((a, b) => (plan[b].length - plan[a].length) || (a - b));
          for (const tgt of swapTargets) {
            for (let swapIdx = 0; swapIdx < plan[tgt].length; swapIdx++) {
              const swapEntry = plan[tgt][swapIdx];
              const swapKlasse = state.klassenMap[swapEntry.klasse];
              const srcInTgt = pruefeSlot(klasse, tgt, plan, belegung, { ...optionen, ignoreQuote: false });
              const swapInSrc = pruefeSlot(swapKlasse, src, plan, belegung, { ...optionen, ignoreQuote: false });
              if (!srcInTgt || !swapInSrc) continue;
              plan[src].splice(idx, 1);
              plan[tgt].splice(swapIdx, 1);
              belegung[src] = new Set(plan[src].flatMap(e => e.lehrer));
              belegung[tgt] = new Set(plan[tgt].flatMap(e => e.lehrer));
              plan[src].push({ klasse: swapEntry.klasse, jahrgang: swapInSrc.jahrgang, lehrer: swapInSrc.lehrer, klassenleiter: swapEntry.klassenleiter, raum: raumFuerSlot(plan, src, swapInSrc.jahrgang, jahrgangRaumMap) });
              plan[tgt].push({ klasse: entry.klasse, jahrgang: srcInTgt.jahrgang, lehrer: srcInTgt.lehrer, klassenleiter: entry.klassenleiter, raum: raumFuerSlot(plan, tgt, srcInTgt.jahrgang, jahrgangRaumMap) });
              srcInTgt.lehrer.forEach(l => belegung[tgt].add(l));
              swapInSrc.lehrer.forEach(l => belegung[src].add(l));
              moved = true;
              break;
            }
            if (moved) break;
          }
          if (moved) break;
        }
        if (moved) break;
      }
    }
  }

  // --- Bei einerProJahrgang + erzwingePackung: Klassen in die vorderen Slots ziehen ---
  // Jeder Slot kann pro Jahrgang nur eine Klasse aufnehmen. Dieser Durchgang
  // verschiebt Klassen aus hinteren Slots nach vorne, wenn dort deren Jahrgang
  // noch fehlt, sodass die vorderen Slots voll werden und der letzte den Rest bekommt.
  if (erzwingePackung && einerProJahrgang) {
    for (let moved = true; moved; ) {
      moved = false;
      for (let src = maxSlots - 1; src > 0; src--) {
        if (plan[src].length === 0) continue;
        const candidates = plan[src].map((entry, idx) => ({ entry, idx }));
        for (const { entry, idx } of candidates) {
          const klasse = state.klassenMap[entry.klasse];
          for (let tgt = 0; tgt < src; tgt++) {
            if (plan[tgt].length >= maxKlassenProSlot) continue;
            const ergebnis = pruefeSlot(klasse, tgt, plan, belegung, { ...optionen, ignoreQuote: false });
            if (!ergebnis) continue;
            plan[src].splice(idx, 1);
            belegung[src] = new Set(plan[src].flatMap(e => e.lehrer));
            plan[tgt].push({ klasse: entry.klasse, jahrgang: ergebnis.jahrgang, lehrer: ergebnis.lehrer, klassenleiter: entry.klassenleiter, raum: raumFuerSlot(plan, tgt, ergebnis.jahrgang, jahrgangRaumMap) });
            ergebnis.lehrer.forEach(l => belegung[tgt].add(l));
            moved = true;
            break;
          }
          if (moved) break;
        }
        if (moved) break;
      }
    }
  }

  // --- Slots auffüllen (Logik unverändert, nur Shuffle-Fix für Zufalls-Tie-Break) ---
  for (let slot = 0; slot < maxSlots; slot++) {
    const besetzt = belegung[slot];
    const slotKlassen = plan[slot];
    if (slotKlassen.length === 0) continue;

    const verfügbareLehrer = shuffle(Array.from(state.anwesendeLehrer).filter(l => !besetzt.has(l)))
      .sort((a, b) => {
        const treffer_A = Math.max(...slotKlassen
          .filter(e => state.klassenMap[e.klasse].lehrerSet.has(a))
          .map(e => countMatchingFaecher(state.klassenMap[e.klasse].lehrerFaecher.get(a) || new Set(), state.bevorzugteFaecher)), 0);
        const treffer_B = Math.max(...slotKlassen
          .filter(e => state.klassenMap[e.klasse].lehrerSet.has(b))
          .map(e => countMatchingFaecher(state.klassenMap[e.klasse].lehrerFaecher.get(b) || new Set(), state.bevorzugteFaecher)), 0);
        return treffer_B - treffer_A;
      });

    const klassenMitQuote = slotKlassen.map(entry => {
      const klasse = state.klassenMap[entry.klasse];
      const anwesendeLehrerDerKlasse = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
      const gesamtLehrer = klasse.lehrerSet.size;
      const quoteBasis = nurAnwesendeFuerQuote ? anwesendeLehrerDerKlasse.length : gesamtLehrer;
      const effektiveQuote = quoteBasis > 0 ? entry.lehrer.length / quoteBasis : 0;
      return { entry, effektiveQuote, gesamtLehrer };
    }).sort((a, b) => a.effektiveQuote - b.effektiveQuote);

    for (const lehrer of verfügbareLehrer) {
      for (const { entry, gesamtLehrer } of klassenMitQuote) {
        const klasse = state.klassenMap[entry.klasse];
        if (klasse.lehrerSet.has(lehrer) && entry.lehrer.length < gesamtLehrer && !(klassenleiterPflicht && lehrer === klasse.kl && entry.lehrer.includes(lehrer))) {
          entry.lehrer.push(lehrer);
          besetzt.add(lehrer);
          const eintrag = klassenMitQuote.find(k => k.entry === entry);
          const anwesendeLehrerDerKlasse = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
          const quoteBasis = nurAnwesendeFuerQuote ? anwesendeLehrerDerKlasse.length : gesamtLehrer;
          eintrag.effektiveQuote = quoteBasis > 0 ? entry.lehrer.length / quoteBasis : 0;
          klassenMitQuote.sort((a, b) => a.effektiveQuote - b.effektiveQuote);
          break;
        }
      }
    }
  }

  // Fächer-Abdeckung des fertigen Plans berechnen (Summe der Treffer über alle
  // tatsächlich zugewiesenen Lehrer-Klasse-Kombinationen) – dient beim
  // Vergleich mehrerer Versuche (siehe naechsterVersuch) als zusätzliches
  // Auswahlkriterium.
  let faecherAbdeckung = 0;
  plan.forEach(slotDaten => {
    slotDaten.forEach(entry => {
      const klasse = state.klassenMap[entry.klasse];
      entry.lehrer.forEach(l => {
        faecherAbdeckung += countMatchingFaecher(klasse.lehrerFaecher.get(l) || new Set(), state.bevorzugteFaecher);
      });
    });
  });

  // Nachkontrolle: alle verplanten Klassen auf Mindestquote prüfen
  plan.forEach((slotDaten, slotIdx) => {
    slotDaten.forEach(entry => {
      const kl = state.klassenMap[entry.klasse];
      const anwesend = Array.from(kl.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
      const basis = nurAnwesendeFuerQuote ? anwesend.length : kl.lehrerSet.size;
      const mindAnwesend = Math.ceil(basis * anwesendQuote);
      if (entry.lehrer.length < mindAnwesend) {
        warnungen.push(`INTERNER FEHLER: Klasse ${entry.klasse} in Slot ${slotIdx + 1} hat nur ${entry.lehrer.length} von benötigten ${mindAnwesend} Lehrern (Basis: ${basis}, Quote: ${anwesendQuote}). Bitte Seite neu laden und erneut versuchen.`);
      }
    });
  });

  return { plan, warnungen, faecherAbdeckung, anwesendQuote, nurAnwesendeFuerQuote };
}

/* ---------------------------------------------------------------
   9) Ergebnisanzeige & manuelle Bearbeitung
   --------------------------------------------------------------- */

function slotZeit(slotIndex) {
  const startZeit = document.getElementById('startZeit')?.value;
  const dauerMin = parseInt(document.getElementById('dauerMinuten')?.value) || 20;
  if (!startZeit) return `Slot ${slotIndex + 1}`;
  const [h, m] = startZeit.split(':').map(Number);
  const pausenMin = (state.pausen || []).filter(p => p.afterSlot < slotIndex).reduce((sum, p) => sum + (parseInt(p.dauer) || 0), 0);
  const startMin = h * 60 + m + slotIndex * dauerMin + pausenMin;
  const endMin = startMin + dauerMin;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)} – ${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)} Uhr`;
}

function slotEndeMinuten(slotIndex) {
  const startZeit = document.getElementById('startZeit')?.value;
  const dauerMin = parseInt(document.getElementById('dauerMinuten')?.value) || 20;
  if (!startZeit) return 0;
  const [h, m] = startZeit.split(':').map(Number);
  const pausenMin = (state.pausen || []).filter(p => p.afterSlot < slotIndex).reduce((sum, p) => sum + (parseInt(p.dauer) || 0), 0);
  return h * 60 + m + (slotIndex + 1) * dauerMin + pausenMin;
}

function pauseZeit(afterSlot, dauer) {
  const startZeit = document.getElementById('startZeit')?.value;
  if (!startZeit) return '';
  const startMin = slotEndeMinuten(afterSlot);
  const endMin = startMin + (parseInt(dauer) || 10);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)} – ${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)} Uhr`;
}

function renderPausenUI() {
  const container = document.getElementById('pausenListe');
  if (!container) return;
  const maxSlots = parseInt(document.getElementById('maxSlots')?.value) || 10;
  container.innerHTML = (state.pausen || []).map((pause, idx) => `
    <div class="pause-eintrag">
      Pause nach Slot
      <select data-pause-idx="${idx}" class="pause-slot-select">
        ${Array.from({ length: maxSlots }, (_, i) => `<option value="${i}"${i === (pause.afterSlot ?? 0) ? ' selected' : ''}>${i + 1}</option>`).join('')}
      </select>
      <input type="number" class="pause-dauer" data-pause-idx="${idx}" value="${pause.dauer || 10}" min="1" max="180" style="width:60px" /> Minuten
      <button type="button" class="pause-entfernen-btn" data-pause-idx="${idx}">×</button>
    </div>
  `).join('');
}

function warnungsTipp(warnung) {
  if (/keinen Klassenleiter zugeordnet/i.test(warnung) && !/in Slot/i.test(warnung)) {
    return 'Tipp: Tragen Sie einen Klassenleiter für die Klasse im CSV-Import ein.';
  }
  if (/Klasse wurde trotzdem verplant/i.test(warnung) && /nicht anwesend/i.test(warnung)) {
    return 'Tipp: Der Klassenleiter ist abwesend – tragen Sie einen Ersatzklassenleiter ein oder verschieben Sie die Klasse manuell.';
  }
  if (/Klassenleiterpflicht aktiviert/i.test(warnung) && (/ist nicht anwesend/i.test(warnung) || /unterrichtet nicht/i.test(warnung))) {
    return 'Tipp: Markieren Sie den Klassenleiter als anwesend oder fügen Sie ihn als Lehrer der Klasse hinzu.';
  }
  if (/keinen Jahrgang zugewiesen/i.test(warnung)) {
    return 'Tipp: Weisen Sie der Klasse einen Jahrgang zu (Eingabefeld neben der Klasse).';
  }
  if (/auch nach Tauschversuch nicht/i.test(warnung) && /Klassenleiter .+ anderweitig verplant/i.test(warnung)) {
    return 'Tipp: Der Klassenleiter ist in allen Slots bereits belegt. Senken Sie die Quote oder erhöhen Sie die Anzahl der Zeitslots.';
  }
  if (/kein passender Slot gefunden/i.test(warnung) && /ohne Quotenzwang/i.test(warnung)) {
    return 'Tipp: Auch ohne Quotenzwang konnte kein Slot gefunden werden – der Klassenleiter ist vermutlich in allen Slots belegt. Tragen Sie einen Ersatzklassenleiter ein.';
  }
  if (/kein passender Slot gefunden/i.test(warnung)) {
    return 'Tipp: Erhöhen Sie die Anzahl der Zeitslots, senken Sie die Mindestanwesenheitsquote, oder stellen Sie sicher, dass mehr Lehrer anwesend sind.';
  }
  if (/ohne Erreichen der Mindestanwesenheitsquote/i.test(warnung)) {
    return 'Tipp: Die Klasse wurde mit weniger als der Mindestquote verplant. Markieren Sie mehr Lehrer als anwesend oder senken Sie die Mindestanwesenheitsquote.';
  }
  if (/INTERNER FEHLER/i.test(warnung)) {
    return 'Tipp: Bitte laden Sie die Seite neu (Strg+F5) und versuchen Sie es erneut.';
  }
  if (/mehrfach anwesend/i.test(warnung)) {
    return 'Tipp: Verschieben Sie eine der Klassen manuell in einen anderen Slot, um den Lehrer-Konflikt aufzulösen.';
  }
  if (/hat nur .+ von .+ Lehrern/i.test(warnung)) {
    return 'Tipp: Markieren Sie mehr Lehrer der Klasse als anwesend, senken Sie die Mindestanwesenheitsquote, oder aktivieren Sie "Nur anwesende Lehrer für Quote".';
  }
  if (/ist in Slot .+ nicht anwesend/i.test(warnung)) {
    return 'Tipp: Der Klassenleiter ist nicht im selben Slot wie seine Klasse. Verschieben Sie die Klasse oder den Lehrer manuell.';
  }
  if (/hat keinen Klassenleiter zugeordnet in Slot/i.test(warnung)) {
    return 'Tipp: Ordnen Sie der Klasse einen Klassenleiter zu.';
  }
  return '';
}

function zeigeErgebnis(ergebnis) {
  const { plan, warnungen, faecherAbdeckung, anwesendQuote: ergebnisQuote, nurAnwesendeFuerQuote: ergebnisNurAnwesende } = ergebnis;
  // Slots nach Anzahl der Konferenzen sortieren (vollste zuerst)
  plan.sort((a, b) => b.length - a.length);
  // Klassen innerhalb jedes Slots nach Jahrgangsstufe sortieren
  plan.forEach(slot => slot.sort((a, b) => (parseInt(a.jahrgang) || 0) - (parseInt(b.jahrgang) || 0)));
  const maxSlots = parseInt(document.getElementById('maxSlots')?.value) || 0;
  const anwesendQuote = (ergebnisQuote ?? parseFloat(document.getElementById('anwesendQuote')?.value)) || 0;
  const klassenleiterPflicht = document.getElementById('klassenleiterPflicht')?.checked;
  const nurAnwesendeFuerQuote = ergebnisNurAnwesende ?? document.getElementById('nurAnwesendeFuerQuote')?.checked;

  const doppelteLehrerWarnungen = [];
  const quoteWarnungen = [];
  const klassenleiterWarnungen = [];
  const doppelteLehrer = new Map();
  const raumDuplikate = new Map();

  let konferenzAnzahl = 0, summeQuote = 0, maxQuote = -Infinity, minQuote = Infinity;
  let maxQuoteKlasse = '', minQuoteKlasse = '';
  let maxFaecherTreffer = 0;

  plan.forEach((slotDaten, slotIndex) => {
    const raumVerwendung = new Map();
    slotDaten.forEach(e => {
      const raum = e.raum || '';
      if (raum) raumVerwendung.set(raum, (raumVerwendung.get(raum) || 0) + 1);
    });
    raumDuplikate.set(slotIndex, raumVerwendung);
  });

  plan.forEach((slotDaten, slotIndex) => {
    const lehrerCount = new Map();
    slotDaten.forEach(e => {
      e.lehrer.forEach(l => {
        lehrerCount.set(l, (lehrerCount.get(l) || 0) + 1);
        if (lehrerCount.get(l) > 1) {
          doppelteLehrerWarnungen.push(`Lehrer ${l} ist in Slot ${slotIndex + 1} mehrfach anwesend.`);
          if (!doppelteLehrer.has(slotIndex)) doppelteLehrer.set(slotIndex, new Set());
          doppelteLehrer.get(slotIndex).add(l);
        }
      });

      const klasse = state.klassenMap[e.klasse];
      const gesamtLehrer = klasse.lehrerSet.size;
      const anwesendeLehrerDerKlasse = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
      const quoteBasis = nurAnwesendeFuerQuote ? anwesendeLehrerDerKlasse.length : gesamtLehrer;
      const effektiveQuote = quoteBasis > 0 ? e.lehrer.length / quoteBasis : 0;
      const quoteErfuellt = e.lehrer.length >= Math.ceil(quoteBasis * anwesendQuote);

      konferenzAnzahl++;
      summeQuote += effektiveQuote;
      if (effektiveQuote > maxQuote) { maxQuote = effektiveQuote; maxQuoteKlasse = e.klasse; }
      if (effektiveQuote < minQuote) { minQuote = effektiveQuote; minQuoteKlasse = e.klasse; }

      // Bestmöglicher Fächertreffer dieser Klasse: wenn ALLE an diesem Tag
      // anwesenden Lehrkräfte der Klasse (nicht nur die tatsächlich
      // eingeplanten) zur Konferenz kämen. Dient als Bezugsgröße für die
      // Prozentangabe unten.
      maxFaecherTreffer += Array.from(klasse.lehrerSet)
        .filter(l => state.anwesendeLehrer.has(l))
        .reduce((sum, l) => sum + countMatchingFaecher(klasse.lehrerFaecher.get(l) || new Set(), state.bevorzugteFaecher), 0);

      if (!quoteErfuellt) {
        quoteWarnungen.push(`Klasse ${e.klasse} in Slot ${slotIndex + 1} hat nur ${e.lehrer.length} von ${nurAnwesendeFuerQuote ? `${anwesendeLehrerDerKlasse.length} anwesenden` : gesamtLehrer} Lehrern (Quote ${(e.lehrer.length / gesamtLehrer).toFixed(2)}, Mindestanwesenheitsquote ${anwesendQuote}).`);
      }
      if (klassenleiterPflicht) {
        if (!klasse.kl) {
          klassenleiterWarnungen.push(`Klasse ${e.klasse} hat keinen Klassenleiter zugeordnet in Slot ${slotIndex + 1} (Klassenleiterpflicht aktiviert, Klasse wurde trotzdem verplant).`);
        } else if (!e.lehrer.includes(klasse.kl)) {
          klassenleiterWarnungen.push(`Klassenleiter ${klasse.kl} der Klasse ${e.klasse} ist in Slot ${slotIndex + 1} nicht anwesend (Klasse wurde trotzdem verplant).`);
        }
      }
    });
  });

  const durchschnittQuote = konferenzAnzahl > 0 ? summeQuote / konferenzAnzahl : 0;
  // "Fächertreffer" nur anzeigen, wenn überhaupt bevorzugte Fächer ausgewählt
  // wurden – sonst ist die Zahl (immer 0) nur verwirrend.
  const faecherTrefferProzent = maxFaecherTreffer > 0 ? ((faecherAbdeckung ?? 0) / maxFaecherTreffer) * 100 : null;
  const faecherTrefferZeile = state.bevorzugteFaecher.size > 0
    ? `<p><strong>Fächertreffer (bevorzugte Fächer):</strong> ${faecherAbdeckung ?? 0} von maximal möglichen ${maxFaecherTreffer}${faecherTrefferProzent !== null ? ` (${faecherTrefferProzent.toFixed(1)} %)` : ''} — bezogen auf die gewählten Fächer (${Array.from(state.bevorzugteFaecher).map(escapeHtml).join(', ')})</p>`
    : '';
  // Slot-Verteilungs-Tipp bei uniformer Packung trotz aktiviertem erzwingePackung
  const belegungCounts = plan.filter(s => s.length > 0).map(s => s.length);
  const maxCount = belegungCounts.length > 0 ? Math.max(...belegungCounts) : 0;
  const minCount = belegungCounts.length > 0 ? Math.min(...belegungCounts) : 0;
  const packingUniform = belegungCounts.length > 1 && maxCount - minCount <= 1;
  const erzwingePackungChecked = document.getElementById('erzwingePackung')?.checked;
  const packungsTipp = erzwingePackungChecked && packingUniform
    ? `<p class="warnungs-tipp">Tipp: Slot-Auslastung ist gleichmäßig, aber nicht verdichtet. Verringern Sie die Mindestanwesenheitsquote, um mehr Spielraum für die Packung zu erhalten.</p>`
    : '';

  const statistikAusgabe = `
    <p><strong>Anzahl der Konferenzen:</strong> ${konferenzAnzahl}</p>
    <p><strong>Slot-Belegung:</strong> ${plan.map(s => s.length).join('-')}</p>
    ${packungsTipp}
    <p><strong>Durchschnittliche Anwesenheitsquote:</strong> ${(durchschnittQuote * 100).toFixed(2)} %</p>
    <p><strong>Maximale Anwesenheitsquote:</strong> ${(maxQuote * 100).toFixed(2)} % (Klasse ${escapeHtml(maxQuoteKlasse)})</p>
    <p><strong>Minimale Anwesenheitsquote:</strong> ${(minQuote * 100).toFixed(2)} % (Klasse ${escapeHtml(minQuoteKlasse)})</p>
    ${faecherTrefferZeile}
  `;

  const alleWarnungen = [...warnungen, ...doppelteLehrerWarnungen, ...quoteWarnungen, ...klassenleiterWarnungen];

  let ausgabe = plan.every(slot => slot.length === 0)
    ? `<div class="warnungen"><strong>Fehler:</strong><p>Keine Klassen konnten verplant werden. Bitte überprüfen Sie die Einstellungen.</p></div>`
    : alleWarnungen.length > 0
      ? `<div class="warnungen"><strong>Warnungen:</strong><ul>${alleWarnungen.map(w => {
        const tipp = warnungsTipp(w);
        return `<li>${escapeHtml(w)}${tipp ? `<br><span class="warnungs-tipp">${escapeHtml(tipp)}</span>` : ''}</li>`;
      }).join('')}</ul></div><div class="info">${statistikAusgabe}</div>`
      : `<div class="info"><strong>Erfolg:</strong><p>Keine Warnungen! Alle Klassen wurden erfolgreich verplant.</p>${statistikAusgabe}</div>`;

  plan.forEach((slotDaten, slotIndex) => {
    const zeit = slotZeit(slotIndex);
    ausgabe += `<h3>${escapeHtml(zeit)} <span class="slot-controls print-hidden">`;
    if (slotIndex > 0) ausgabe += `<button class="move-slot-up" data-slot="${slotIndex}">↑ Nach oben</button> `;
    if (slotIndex < maxSlots - 1) ausgabe += `<button class="move-slot-down" data-slot="${slotIndex}">↓ Nach unten</button> `;
    ausgabe += `<select class="slot-mover print-hidden" data-current-slot="${slotIndex}"><option value="${slotIndex}">Bleibt in Slot ${slotIndex + 1} (${escapeHtml(slotZeit(slotIndex))})</option>`;
    for (let i = 0; i < maxSlots; i++) {
      if (i !== slotIndex) ausgabe += `<option value="${i}">In Slot ${i + 1} (${escapeHtml(slotZeit(i))}) verschieben</option>`;
    }
    ausgabe += `</select></span></h3>`;
    ausgabe += '<table border="1" cellpadding="5" cellspacing="0"><thead><tr><th>Klasse</th><th>Raum</th><th>Anwesend</th><th>Möglich</th><th>Quote</th><th class="print-hidden">Slot</th></tr></thead><tbody>';

    slotDaten.forEach(e => {
      const kl = state.klassenMap[e.klasse];
      const alleLehrerDerKlasse = Array.from(kl.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
      const anwesend = e.lehrer;
      const moeglich = alleLehrerDerKlasse.filter(l => !anwesend.includes(l));
      const gesamtLehrer = kl.lehrerSet.size;
      const quoteBasis = nurAnwesendeFuerQuote ? alleLehrerDerKlasse.length : gesamtLehrer;
      const eAnwesendQuote = anwesend.length / gesamtLehrer;
      const quoteErfuellt = anwesend.length >= Math.ceil(quoteBasis * anwesendQuote);

      const anwesendHTML = anwesend.map(l => {
        const isDoppelt = doppelteLehrer.has(slotIndex) && doppelteLehrer.get(slotIndex).has(l);
        const faecher = kl.lehrerFaecher.get(l) ? Array.from(kl.lehrerFaecher.get(l)).join(', ') : '';
        return `<li${isDoppelt ? ' class="doppelter-lehrer"' : ''}>${escapeHtml(l)}${faecher ? ` (${escapeHtml(faecher)})` : ''} <a href="#" class="move-teacher-right print-hidden" data-slot="${slotIndex}" data-klasse="${escapeHtml(e.klasse)}" data-lehrer="${escapeHtml(l)}">→</a></li>`;
      }).join('');

      const moeglichHTML = moeglich.length > 0
        ? `<ul>${moeglich.map(l => {
          const faecher = kl.lehrerFaecher.get(l) ? Array.from(kl.lehrerFaecher.get(l)).join(', ') : '';
          return `<li><a href="#" class="move-teacher-left print-hidden" data-slot="${slotIndex}" data-klasse="${escapeHtml(e.klasse)}" data-lehrer="${escapeHtml(l)}">←</a> ${escapeHtml(l)}${faecher ? ` (${escapeHtml(faecher)})` : ''}</li>`;
        }).join('')}</ul>`
        : '<em>Keine</em>';

      const dropdownHTML = `<select class="slot-changer print-hidden" data-klasse="${escapeHtml(e.klasse)}" data-current-slot="${slotIndex}">${Array.from({ length: maxSlots }, (_, i) => `<option value="${i}"${i === slotIndex ? ' selected' : ''}>Slot ${i + 1} (${escapeHtml(slotZeit(i))})</option>`).join('')}</select>`;

      const raumOptions = state.raeume.map((raum, index) => `<option value="${escapeHtml(raum || '')}"${(e.raum || '') === (raum || '') ? ' selected' : ''}>${escapeHtml(raum || `Raum ${index + 1}`)}</option>`).join('');
      const raumDuplikat = raumDuplikate.get(slotIndex) && raumDuplikate.get(slotIndex).get(e.raum || '') > 1;
      const raumClass = raumDuplikat ? ' class="raum-duplikat"' : '';
      const raumHinweis = raumDuplikat ? ' <span class="raum-hinweis">(Mehrfachnutzung!)</span>' : '';
      const quoteUnterschritten = !quoteErfuellt;
      const quoteClass = quoteUnterschritten ? ' class="quote-unterschritten"' : '';

      ausgabe += `<tr><td>${escapeHtml(e.klasse)} (${e.klassenleiter ? escapeHtml(e.klassenleiter) : '<em>...</em>'})</td><td class="print-hidden"${raumClass}><select class="raum-select" data-slot="${slotIndex}" data-klasse="${escapeHtml(e.klasse)}">${raumOptions}</select>${raumHinweis}</td><td><ul>${anwesendHTML}</ul></td><td>${moeglichHTML}</td><td${quoteClass}>${(eAnwesendQuote * 100).toFixed(0)} % von ${gesamtLehrer}</td><td class="print-hidden">${dropdownHTML}</td></tr>`;
    });

    ausgabe += '</tbody></table>';
  });

  const planOutput = document.getElementById('planOutput');
  if (planOutput) planOutput.innerHTML = ausgabe;
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.style.display = 'block';
  const exportLehrerBtn = document.getElementById('exportLehrerBtn');
  if (exportLehrerBtn) exportLehrerBtn.style.display = 'block';

  addSlotChangeListeners(plan, ergebnis);
  addTeacherMoveListeners(plan, ergebnis);
  addSlotMoveListeners(plan, ergebnis);
  addRaumSelectListeners(plan, ergebnis);
}

function addSlotChangeListeners(plan, ergebnis) {
  document.querySelectorAll('.slot-changer').forEach(select => {
    select.addEventListener('change', function () {
      const klasse = this.dataset.klasse;
      const currentSlot = parseInt(this.dataset.currentSlot);
      const newSlot = parseInt(this.value);
      const klassenleiterPflicht = document.getElementById('klassenleiterPflicht')?.checked;
      const einerProJahrgang = document.getElementById('einerProJahrgang')?.checked;

      if (currentSlot === newSlot) return;

      const currentSlotData = plan[currentSlot];
      const klasseEntry = currentSlotData.find(e => e.klasse === klasse);
      if (!klasseEntry) {
        alert(`Klasse ${klasse} nicht im Zeitfenster ${currentSlot + 1} gefunden!`);
        return;
      }

      if (einerProJahrgang) {
        const jahrgang = state.klassenMap[klasse].manuellerJahrgang || state.klassenMap[klasse].name.match(/^(\d+)/)?.[1] || null;
        const slotJahrgaenge = plan[newSlot].map(p => p.jahrgang);
        if (jahrgang && slotJahrgaenge.includes(jahrgang)) {
          if (!confirm(`Warnung: Jahrgang ${jahrgang} ist bereits in Zeitfenster ${newSlot + 1} vorhanden. Möchten Sie die Klasse trotzdem verschieben?`)) {
            this.value = currentSlot;
            return;
          }
        }
      }

      currentSlotData.splice(currentSlotData.indexOf(klasseEntry), 1);
      plan[newSlot].push(klasseEntry);
      state.aktuellerPlan.plan = plan;
      speicherePlan();
      zeigeErgebnis(ergebnis);
    });
  });
}

function addRaumSelectListeners(plan, ergebnis) {
  document.querySelectorAll('.raum-select').forEach(select => {
    select.addEventListener('change', function () {
      const slotIndex = parseInt(this.dataset.slot);
      const klasse = this.dataset.klasse;
      const newRaum = this.value.trim();

      const entry = plan[slotIndex].find(e => e.klasse === klasse);
      if (entry) {
        entry.raum = newRaum || '';
        state.aktuellerPlan.plan = plan;
        speicherePlan();
        zeigeErgebnis(ergebnis);
      }
    });
  });
}

function addTeacherMoveListeners(plan, ergebnis) {
  const anwesendQuote = parseFloat(document.getElementById('anwesendQuote')?.value) || 0;
  const klassenleiterPflicht = document.getElementById('klassenleiterPflicht')?.checked;

  document.querySelectorAll('.move-teacher-left').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const slotIndex = parseInt(link.dataset.slot);
      const klasse = link.dataset.klasse;
      const lehrer = link.dataset.lehrer;

      if (!state.klassenMap[klasse].lehrerSet.has(lehrer)) {
        alert(`${lehrer} ist nicht für die Klasse ${klasse} zugelassen!`);
        return;
      }

      const currentSlot = plan[slotIndex];
      const targetKlasse = currentSlot.find(e => e.klasse === klasse);
      const lehrerInAnderenKlassen = new Set(currentSlot.filter(e => e.klasse !== klasse).flatMap(e => e.lehrer));
      const istDoppelt = lehrerInAnderenKlassen.has(lehrer);

      targetKlasse.lehrer.push(lehrer);
      speicherePlan();
      zeigeErgebnis(ergebnis);
      if (istDoppelt) {
        alert(`Warnung: Lehrer ${lehrer} ist in Zeitfenster ${slotIndex + 1} bereits in einer anderen Klasse anwesend!`);
      }
    });
  });

  document.querySelectorAll('.move-teacher-right').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const slotIndex = parseInt(link.dataset.slot);
      const klasse = link.dataset.klasse;
      const lehrer = link.dataset.lehrer;

      const currentSlot = plan[slotIndex];
      const targetKlasse = currentSlot.find(e => e.klasse === klasse);

      if (!targetKlasse.lehrer.includes(lehrer)) {
        alert(`${lehrer} ist nicht in der Liste der anwesenden Lehrer für ${klasse}!`);
        return;
      }

      if (klassenleiterPflicht && state.klassenMap[klasse].kl === lehrer) {
        addStatusMessage(`${lehrer} ist der Klassenleiter von ${klasse} – Klassenleiterpflicht wird verletzt.`, false, true);
      }

      targetKlasse.lehrer.splice(targetKlasse.lehrer.indexOf(lehrer), 1);
      speicherePlan();
      zeigeErgebnis(ergebnis);
    });
  });
}

function addSlotMoveListeners(plan, ergebnis) {
  document.querySelectorAll('.move-slot-up').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const slotIndex = parseInt(e.target.dataset.slot);
      if (slotIndex > 0) {
        [plan[slotIndex - 1], plan[slotIndex]] = [plan[slotIndex], plan[slotIndex - 1]];
        state.aktuellerPlan.plan = plan;
        speicherePlan();
        zeigeErgebnis(ergebnis);
      }
    });
  });

  document.querySelectorAll('.move-slot-down').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const slotIndex = parseInt(e.target.dataset.slot);
      if (slotIndex < plan.length - 1 && plan[slotIndex + 1].length > 0) {
        [plan[slotIndex + 1], plan[slotIndex]] = [plan[slotIndex], plan[slotIndex + 1]];
        state.aktuellerPlan.plan = plan;
        speicherePlan();
        zeigeErgebnis(ergebnis);
      }
    });
  });

  document.querySelectorAll('.slot-mover').forEach(select => {
    select.addEventListener('change', (e) => {
      const currentSlot = parseInt(e.target.dataset.currentSlot);
      const newSlot = parseInt(e.target.value);
      if (currentSlot === newSlot) {
        e.target.value = currentSlot;
        return;
      }

      const temp = plan[newSlot];
      plan[newSlot] = plan[currentSlot];
      plan[currentSlot] = temp;

      state.aktuellerPlan.plan = plan;
      speicherePlan();
      zeigeErgebnis(ergebnis);
    });
  });
}

/* ---------------------------------------------------------------
   10) Export
   --------------------------------------------------------------- */

function exportKlassenplan() {
  if (!state.aktuellerPlan) {
    alert('Kein Plan zum Exportieren verfügbar. Bitte erstellen Sie zuerst einen Plan.');
    return;
  }

  let csvContent = '\uFEFFSlot;Uhrzeit;Klasse;Raum;Klassenleiter;Lehrkräfte\n';
  state.aktuellerPlan.plan.forEach((slot, slotIndex) => {
    const zeit = slotZeit(slotIndex);
    slot.forEach(entry => {
      csvContent += [
        csvEscape(`Slot ${slotIndex + 1}`),
        csvEscape(zeit),
        csvEscape(entry.klasse),
        csvEscape(entry.raum || ''),
        csvEscape(entry.klassenleiter || ''),
        csvEscape(entry.lehrer.join(', ')),
      ].join(';') + '\n';
    });
    (state.pausen || []).filter(p => p.afterSlot === slotIndex).forEach(p => {
      csvContent += [
        csvEscape('Pause'),
        csvEscape(pauseZeit(p.afterSlot, p.dauer)),
        '', '', '', '',
      ].join(';') + '\n';
    });
  });

  downloadCSV(csvContent, 'klassenkonferenz_plan.csv');
}

function exportLehrerplan() {
  if (!state.aktuellerPlan) {
    alert('Kein Plan zum Exportieren verfügbar. Bitte erstellen Sie zuerst einen Plan.');
    return;
  }

  const maxSlots = state.aktuellerPlan.plan.length;
  const lehrerPlan = new Map(Array.from(state.anwesendeLehrer).sort().map(lehrer => [lehrer, Array(maxSlots).fill('')]));
  state.aktuellerPlan.plan.forEach((slot, slotIndex) => {
    slot.forEach(entry => {
      entry.lehrer.forEach(lehrer => {
        if (lehrerPlan.has(lehrer)) {
          lehrerPlan.get(lehrer)[slotIndex] = lehrerPlan.get(lehrer)[slotIndex] ? `${lehrerPlan.get(lehrer)[slotIndex]}, ${entry.klasse}` : entry.klasse;
        }
      });
    });
  });

  let csvContent = '\uFEFFLehrer;' + Array.from({ length: maxSlots }, (_, i) => `Slot ${i + 1} (${slotZeit(i)})`).join(';') + '\n';
  lehrerPlan.forEach((slots, lehrer) => {
    csvContent += csvEscape(lehrer) + ';' + slots.map(slot => csvEscape(slot)).join(';') + '\n';
  });

  downloadCSV(csvContent, 'lehrer_konferenz_plan.csv');
}

function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function exportUnterrichtCSV() {
  const csv = getFromLocalStorage('unterrichtCSV');
  if (!csv) { alert('Keine Unterrichtsdaten zum Exportieren vorhanden.'); return; }
  downloadCSV('\uFEFF' + csv, 'unterricht.csv');
}

function exportKlassenleiterCSV() {
  const csv = getFromLocalStorage('klassenleiterCSV');
  if (!csv) { alert('Keine Klassenleiterdaten zum Exportieren vorhanden.'); return; }
  downloadCSV('\uFEFF' + csv, 'klassenleiter.csv');
}

/* ---------------------------------------------------------------
   11) Initialisierung
   --------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOMContentLoaded ausgelöst');

  enableDragAndDrop('dropZoneKlassenleiter', 'klassenleiterInput');
  enableDragAndDrop('dropZoneUnterricht', 'unterrichtInput');

  // FAQ-Akkordeon: nur ein geöffnetes Element gleichzeitig
  const details = document.querySelectorAll('.faq-item');
  details.forEach((detail) => {
    detail.addEventListener('toggle', () => {
      if (detail.open) {
        details.forEach((otherDetail) => {
          if (otherDetail !== detail && otherDetail.open) otherDetail.open = false;
        });
      }
    });
  });

  const loadingIndicator = document.getElementById('loadingIndicator');
  if (loadingIndicator) loadingIndicator.classList.add('active');
  else console.error('loadingIndicator nicht gefunden');

  // Einmaliges Laden aller Daten beim Start (vorher versehentlich doppelt).
  await ladeGespeicherteCSV();
  ladePlanungsoptionen();
  await zeigeCSVBearbeitung();
  updateUI();

  if (state.aktuellerPlan) {
    activateTab('planung');
    zeigeErgebnis(state.aktuellerPlan);
  }

  const storedMessages = getFromLocalStorage('csvMessages');
  const csvMessageDiv = document.getElementById('csvMessage');
  if (storedMessages && csvMessageDiv) {
    renderStatusMessages(JSON.parse(storedMessages), csvMessageDiv);
  }

  if (loadingIndicator) loadingIndicator.classList.remove('active');

  // --- Globale Change-/Input-Listener ---
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('jahrgangInput')) speichereAuswahl();
  });

  document.addEventListener('change', (e) => {
    if (
      e.target.classList.contains('klasseCheckbox') ||
      e.target.classList.contains('lehrerCheckbox') ||
      e.target.classList.contains('jahrgangInput')
    ) {
      speichereAuswahl();
    }
    if (e.target.classList.contains('fachCheckbox')) {
      if (e.target.checked) state.bevorzugteFaecher.add(e.target.value);
      else state.bevorzugteFaecher.delete(e.target.value);
      speicherePlanungsoptionen();
    }
  });

  // --- Tabs ---
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => {
      activateTab(button.getAttribute('data-tab'));
      toggleJahrgangInputs();
    });
  });

  // --- Datei-Uploads ---
  const unterrichtInput = document.getElementById('unterrichtInput');
  if (unterrichtInput) {
    unterrichtInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) {
        addStatusMessage('Keine Unterrichts-Datei ausgewählt.', true);
        return;
      }
      if (loadingIndicator) loadingIndicator.classList.add('active');

      const reader = new FileReader();
      reader.onload = async (ev) => {
        saveToLocalStorage('unterrichtCSV', ev.target.result.trim());
        state.unterrichtLoaded = true;
        await ladeGespeicherteCSV('unterricht');
        updateUI();
        if (loadingIndicator) loadingIndicator.classList.remove('active');
      };
      reader.onerror = () => {
        addStatusMessage('Fehler beim Lesen der Unterrichts-Datei.', true);
        if (loadingIndicator) loadingIndicator.classList.remove('active');
      };
      reader.readAsText(file, 'utf-8');
    });
  } else {
    console.error("Element mit ID 'unterrichtInput' wurde nicht gefunden.");
  }

  const klassenleiterInput = document.getElementById('klassenleiterInput');
  if (klassenleiterInput) {
    klassenleiterInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) {
        addStatusMessage('Keine Klassenleiter-Datei ausgewählt.', true);
        return;
      }
      if (loadingIndicator) loadingIndicator.classList.add('active');

      const reader = new FileReader();
      reader.onload = async (ev) => {
        saveToLocalStorage('klassenleiterCSV', ev.target.result.trim());
        state.klassenleiterLoaded = true;
        await ladeGespeicherteCSV('klassenleiter');
        updateUI();
        if (loadingIndicator) loadingIndicator.classList.remove('active');
      };
      reader.onerror = () => {
        addStatusMessage('Fehler beim Lesen der Klassenleiter-Datei.', true);
        if (loadingIndicator) loadingIndicator.classList.remove('active');
      };
      reader.readAsText(file, 'utf-8');
    });
  } else {
    console.error("Element mit ID 'klassenleiterInput' wurde nicht gefunden.");
  }

  // --- Reset ---
  const resetCSV = document.getElementById('resetCSV');
  if (resetCSV) {
    resetCSV.addEventListener('click', () => {
      ['unterrichtCSV', 'klassenleiterCSV', 'planDaten', 'auswahlDaten', 'csvMessages'].forEach(key => localStorage.removeItem(key));
      state.unterrichtLoaded = false;
      state.klassenleiterLoaded = false;
      state.aktuellerPlan = null;
      state.anwesendeLehrer = new Set();
      state.bevorzugteFaecher = new Set();
      state.raeume = [];
      state.lehrerSet.clear();
      state.faecherSet.clear();
      state.klassenMap = {};
      updateUI();
      ladeAuswahl();

      const planOutput = document.getElementById('planOutput');
      if (planOutput) planOutput.innerHTML = '';
      const exportBtn = document.getElementById('exportBtn');
      if (exportBtn) exportBtn.style.display = 'none';
      const exportLehrerBtn = document.getElementById('exportLehrerBtn');
      if (exportLehrerBtn) exportLehrerBtn.style.display = 'none';
      const csvMessageDiv = document.getElementById('csvMessage');
      if (csvMessageDiv) csvMessageDiv.innerHTML = '';
      addStatusMessage('Alle Daten wurden zurückgesetzt.');
    });
  } else {
    console.error("Element mit ID 'resetCSV' wurde nicht gefunden.");
  }

  // --- Zeilen hinzufügen/speichern/löschen (Unterricht) ---
  const addUnterrichtRow = document.getElementById('addUnterrichtRow');
  if (addUnterrichtRow) {
    addUnterrichtRow.addEventListener('click', () => {
      const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
      const lines = unterrichtCSV ? unterrichtCSV.split('\n').filter(line => line.trim()) : [];
      addTableRow('unterrichtCSVBody', ['klasse', 'fach', 'lehrkraft'], lines.length);
    });
  }

  const saveUnterrichtCSV = document.getElementById('saveUnterrichtCSV');
  if (saveUnterrichtCSV) {
    saveUnterrichtCSV.addEventListener('click', () => {
      const unterrichtBody = document.getElementById('unterrichtCSVBody');
      const firstRow = unterrichtBody?.querySelector('tr');
      const fields = firstRow
        ? Array.from(firstRow.querySelectorAll('input[data-field]')).map(input => input.dataset.field)
        : ['klasse', 'fach', 'lehrkraft'];
      saveCSV('unterrichtCSVBody', 'unterrichtCSV', fields, 'Unterricht wurde gespeichert.');
    });
  }

  // --- Zeilen hinzufügen/speichern (Klassenleiter) ---
  const addKlassenleiterRow = document.getElementById('addKlassenleiterRow');
  if (addKlassenleiterRow) {
    addKlassenleiterRow.addEventListener('click', () => {
      const klassenleiterCSV = getFromLocalStorage('klassenleiterCSV');
      const lines = klassenleiterCSV ? klassenleiterCSV.split('\n').filter(line => line.trim()) : [];
      addTableRow('klassenleiterCSVBody', ['klasse', 'klassenleitung'], lines.length);
    });
  }

  const saveKlassenleiterCSV = document.getElementById('saveKlassenleiterCSV');
  if (saveKlassenleiterCSV) {
    saveKlassenleiterCSV.addEventListener('click', () => {
      saveCSV('klassenleiterCSVBody', 'klassenleiterCSV', ['klasse', 'klassenleitung'], 'Klassenleiter wurden gespeichert.');
    });
  }

  document.getElementById('exportUnterrichtCSV')?.addEventListener('click', exportUnterrichtCSV);
  document.getElementById('exportKlassenleiterCSV')?.addEventListener('click', exportKlassenleiterCSV);

  document.getElementById('deleteSelectedUnterrichtRows')?.addEventListener('click', () => deleteSelectedRows('unterricht'));
  document.getElementById('deleteSelectedKlassenleiterRows')?.addEventListener('click', () => deleteSelectedRows('klassenleiter'));

  // --- Sonstige Optionen ---
  const einerProJahrgang = document.getElementById('einerProJahrgang');
  if (einerProJahrgang) {
    einerProJahrgang.addEventListener('change', toggleJahrgangInputs);
  } else {
    console.error("Element mit ID 'einerProJahrgang' wurde nicht gefunden.");
  }

  const maxSlotsInput = document.getElementById('maxSlots');
  if (maxSlotsInput) {
    maxSlotsInput.addEventListener('input', () => {
      renderPausenUI();
      speicherePlanungsoptionen();
    });
  }

  const maxKlassenProSlotInput = document.getElementById('maxKlassenProSlot');
  if (maxKlassenProSlotInput) {
    maxKlassenProSlotInput.addEventListener('input', () => {
      updateRaeumeUI();
      speicherePlanungsoptionen();
    });
  }

  document.getElementById('nurAnwesendeFuerQuote')?.addEventListener('change', speicherePlanungsoptionen);
  document.getElementById('ignoreQuote')?.addEventListener('change', speicherePlanungsoptionen);
  document.getElementById('erzwingePackung')?.addEventListener('change', speicherePlanungsoptionen);
  document.getElementById('startZeit')?.addEventListener('change', speicherePlanungsoptionen);
  document.getElementById('dauerMinuten')?.addEventListener('change', speicherePlanungsoptionen);

  // --- Pausen ---
  document.getElementById('pauseHinzufuegenBtn')?.addEventListener('click', () => {
    state.pausen.push({ afterSlot: 0, dauer: 10 });
    renderPausenUI();
    speicherePlanungsoptionen();
  });

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('pause-slot-select')) {
      const idx = parseInt(e.target.dataset.pauseIdx);
      state.pausen[idx].afterSlot = parseInt(e.target.value);
      speicherePlanungsoptionen();
    }
    if (e.target.classList.contains('pause-dauer')) {
      const idx = parseInt(e.target.dataset.pauseIdx);
      state.pausen[idx].dauer = parseInt(e.target.value) || 10;
      speicherePlanungsoptionen();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('pause-entfernen-btn')) {
      const idx = parseInt(e.target.dataset.pauseIdx);
      state.pausen.splice(idx, 1);
      renderPausenUI();
      speicherePlanungsoptionen();
    }
  });

  document.getElementById('selectAllKlassen')?.addEventListener('click', selectAllKlassen);
  document.getElementById('selectAllLehrer')?.addEventListener('click', selectAllLehrer);

  // --- Planerstellung ---
  const planBtn = document.getElementById('planBtn');
  if (planBtn) {
    planBtn.addEventListener('click', () => {
      if (!state.unterrichtLoaded) {
        alert('Bitte sowohl die Unterrichts- als auch die Klassenleiter-Datei hochladen.');
        return;
      }

      const selectedKlassen = Array.from(document.querySelectorAll('.klasseCheckbox:checked')).map(cb => cb.value);
      state.anwesendeLehrer = new Set(Array.from(document.querySelectorAll('.lehrerCheckbox:checked')).map(cb => cb.value));
      state.bevorzugteFaecher = new Set(Array.from(document.querySelectorAll('.fachCheckbox:checked')).map(cb => cb.value));
      speicherePlanungsoptionen();

      const maxSlots = parseInt(document.getElementById('maxSlots')?.value) || 0;
      const maxKlassenProSlot = parseInt(document.getElementById('maxKlassenProSlot')?.value) || 0;
      const anwesendQuote = parseFloat(document.getElementById('anwesendQuote')?.value) || 0.0;
      const klassenleiterPflicht = document.getElementById('klassenleiterPflicht')?.checked;
      const einerProJahrgang = document.getElementById('einerProJahrgang')?.checked;
      const nurAnwesendeFuerQuote = document.getElementById('nurAnwesendeFuerQuote')?.checked;
      const ignoreQuote = document.getElementById('ignoreQuote')?.checked;
      const erzwingePackung = document.getElementById('erzwingePackung')?.checked;

      if (selectedKlassen.length === 0 || state.anwesendeLehrer.size === 0) {
        alert('Bitte Klassen und Lehrer auswählen.');
        return;
      }
      if (maxKlassenProSlot < 1) {
        alert('Die maximale Anzahl an Klassen pro Zeitfenster muss mindestens 1 sein.');
        return;
      }

      let minSlotsBenötigt = Math.ceil(selectedKlassen.length / maxKlassenProSlot);
      let maxProJahrgang = 0;
      // Bei "eine Klasse pro Jahrgang je Slot": größte Jahrgangsstufe bestimmt Min-Slots
      if (einerProJahrgang) {
        const proJahrgang = {};
        selectedKlassen.forEach(name => {
          const klasse = state.klassenMap[name];
          const jg = klasse.manuellerJahrgang || klasse.name.match(/^(\d+)/)?.[1] || 'kein_jg';
          proJahrgang[jg] = (proJahrgang[jg] || 0) + 1;
        });
        maxProJahrgang = Math.max(...Object.values(proJahrgang));
        minSlotsBenötigt = Math.max(minSlotsBenötigt, maxProJahrgang);
      }
      if (maxSlots < minSlotsBenötigt) {
        const msg = einerProJahrgang
          ? `Bei "eine Klasse pro Jahrgang je Slot" werden mindestens ${minSlotsBenötigt} Zeitslots benötigt (${maxProJahrgang} Klassen in der größten Jahrgangsstufe).`
          : `Mit ${maxKlassenProSlot} Klassen pro Zeitfenster benötigen Sie mindestens ${minSlotsBenötigt} Zeitfenster für ${selectedKlassen.length} Klassen.`;
        alert(`${msg} Bitte erhöhen Sie die Anzahl der Zeitfenster oder reduzieren Sie die Anzahl der Klassen.`);
        return;
      }

      if (einerProJahrgang) {
        document.querySelectorAll('.jahrgangInput').forEach(input => {
          const klasse = input.closest('.jahrgang-input').dataset.klasse;
          const value = input.value.trim();
          state.klassenMap[klasse].manuellerJahrgang = value && !isNaN(value) && parseInt(value) >= 1 && parseInt(value) <= 13 ? value : null;
        });
      }

      const statusDiv = document.getElementById('planOutput');
      if (statusDiv) statusDiv.innerHTML = '<p><strong>Berechne optimale Lösung...</strong></p>';
      activateTab('planung');

      const maxVersuche = Number(document.getElementById('maxVersucheSlider').value);
      let versuchNr = 0, besteErgebnis = null, wenigstenWarnungen = Infinity, bestePackung = -Infinity, besteMinQuote = -Infinity, besteFaecherAbdeckung = -Infinity, besteQuoteVarianz = Infinity;
      // Toleranz für Quoten-Vergleiche, damit Gleichstände nicht durch reines
      // Fließkomma-Rauschen (z. B. 3/5 vs. 6/10) entschieden werden.
      const QUOTE_TOLERANZ = 0.001;

      function naechsterVersuch() {
        versuchNr++;
        const ergebnis = versuchePlanung(maxSlots, maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, nurAnwesendeFuerQuote, ignoreQuote, selectedKlassen, erzwingePackung);
        const quoten = ergebnis.plan.flat().map(entry => {
          const kl = state.klassenMap[entry.klasse];
          const basis = nurAnwesendeFuerQuote ? Array.from(kl.lehrerSet).filter(l => state.anwesendeLehrer.has(l)).length : kl.lehrerSet.size;
          return basis > 0 ? entry.lehrer.length / basis : 0;
        });
        const durchschnitt = quoten.length > 0 ? quoten.reduce((sum, q) => sum + q, 0) / quoten.length : 0;
        const varianz = quoten.length > 0 ? quoten.reduce((sum, q) => sum + Math.pow(q - durchschnitt, 2), 0) / quoten.length : Infinity;
        const minQuote = quoten.length > 0 ? Math.min(...quoten) : -Infinity;
        // Packungs-Score: Summe der Quadrate der Slot-Belegungen – belohnt
        // möglichst voll gefüllte Slots (5²+5²+2² = 54 > 4²+4²+4² = 48)
        const packungScore = ergebnis.plan.reduce((sum, slot) => sum + slot.length * slot.length, 0);

        // Auswahlkriterien: bei erzwingePackung hat Packungs-Score Vorrang vor Quote
        const istBesser = erzwingePackung
          ? (ergebnis.warnungen.length < wenigstenWarnungen ||
             (ergebnis.warnungen.length === wenigstenWarnungen && packungScore > bestePackung) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && packungScore === bestePackung && minQuote > besteMinQuote + QUOTE_TOLERANZ) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && packungScore === bestePackung && Math.abs(minQuote - besteMinQuote) <= QUOTE_TOLERANZ && ergebnis.faecherAbdeckung > besteFaecherAbdeckung) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && packungScore === bestePackung && Math.abs(minQuote - besteMinQuote) <= QUOTE_TOLERANZ && ergebnis.faecherAbdeckung === besteFaecherAbdeckung && varianz < besteQuoteVarianz))
          : (ergebnis.warnungen.length < wenigstenWarnungen ||
             (ergebnis.warnungen.length === wenigstenWarnungen && minQuote > besteMinQuote + QUOTE_TOLERANZ) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && Math.abs(minQuote - besteMinQuote) <= QUOTE_TOLERANZ && packungScore > bestePackung) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && Math.abs(minQuote - besteMinQuote) <= QUOTE_TOLERANZ && packungScore === bestePackung && ergebnis.faecherAbdeckung > besteFaecherAbdeckung) ||
             (ergebnis.warnungen.length === wenigstenWarnungen && Math.abs(minQuote - besteMinQuote) <= QUOTE_TOLERANZ && packungScore === bestePackung && ergebnis.faecherAbdeckung === besteFaecherAbdeckung && varianz < besteQuoteVarianz));

        if (istBesser) {
          wenigstenWarnungen = ergebnis.warnungen.length;
          bestePackung = packungScore;
          besteMinQuote = minQuote;
          besteFaecherAbdeckung = ergebnis.faecherAbdeckung;
          besteQuoteVarianz = varianz;
          besteErgebnis = ergebnis;
        }

        if (statusDiv) {
          statusDiv.innerHTML = `<p><strong>Versuch ${versuchNr}/${maxVersuche} - Beste Lösung bisher: ${wenigstenWarnungen} Warnungen, Packung: ${bestePackung > -Infinity ? bestePackung : '-'}, min. Quote: ${isFinite(besteMinQuote) ? (besteMinQuote * 100).toFixed(0) + ' %' : 'Keine Klassen verplant'}, Fächer-Treffer: ${isFinite(besteFaecherAbdeckung) ? besteFaecherAbdeckung : 0}, Varianz: ${isFinite(besteQuoteVarianz) ? besteQuoteVarianz.toFixed(4) : 'Keine Klassen verplant'}</strong></p>`;
        }

        if (versuchNr < maxVersuche) {
          setTimeout(naechsterVersuch, 1);
        } else {
          if (statusDiv) {
            statusDiv.innerHTML = `<p><strong>${maxVersuche} Versuche abgeschlossen. Beste gefundene Lösung mit ${wenigstenWarnungen} Warnungen, Packung: ${bestePackung > -Infinity ? bestePackung : '-'}, min. Quote ${isFinite(besteMinQuote) ? (besteMinQuote * 100).toFixed(0) + ' %' : 'Keine Klassen verplant'}, ${isFinite(besteFaecherAbdeckung) ? besteFaecherAbdeckung : 0} Fächer-Treffern und Varianz ${isFinite(besteQuoteVarianz) ? besteQuoteVarianz.toFixed(4) : 'Keine Klassen verplant'} wird angezeigt.</strong></p>`;
          }
          state.aktuellerPlan = besteErgebnis;
          speicherePlan();
          zeigeErgebnis(besteErgebnis);
        }
      }

      naechsterVersuch();
    });
  } else {
    console.error("Element mit ID 'planBtn' wurde nicht gefunden.");
  }

  document.getElementById('exportBtn')?.addEventListener('click', exportKlassenplan);
  document.getElementById('exportLehrerBtn')?.addEventListener('click', exportLehrerplan);

  // --- Scroll-to-Top Button ---
  document.getElementById('scrollToTopBtn')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});