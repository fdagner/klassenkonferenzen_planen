// Globale Variablen
const state = {
  klassenMap: {},
  lehrerSet: new Set(),
  faecherSet: new Set(),
  unterrichtLoaded: false,
  klassenleiterLoaded: false,
  aktuellerPlan: null,
  anwesendeLehrer: new Set(),
  bevorzugteFaecher: new Set(),
  raeume: [], // Neues Array für Räume
};
// ZUERST: Funktion definieren
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
      const event = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(event);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('dropZoneKlassenleiter') && document.getElementById('klassenleiterInput')) {
    enableDragAndDrop('dropZoneKlassenleiter', 'klassenleiterInput');
  }

  if (document.getElementById('dropZoneUnterricht') && document.getElementById('unterrichtInput')) {
    enableDragAndDrop('dropZoneUnterricht', 'unterrichtInput');
  }
});


function addStatusMessage(message, isError = false, isWarning = false) {
  const csvMessageDiv = document.getElementById('csvMessage');
  if (!csvMessageDiv) {
    console.error("Element mit ID 'csvMessage' wurde nicht gefunden.");
    return;
  }

  // Erstelle Zeitstempel im Format DD.MM.YYYY HH:MM:SS
  const now = new Date();
  const timestamp = `${now.getDate().toString().padStart(2, '0')}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  // Erstelle Nachricht mit Zeitstempel
  const messageWithTimestamp = `[${timestamp}] ${message}`;

  // Lade bestehende Nachrichten aus localStorage
  const storedMessages = getFromLocalStorage('csvMessages') ? JSON.parse(getFromLocalStorage('csvMessages')) : [];

  // Füge neue Nachricht am Anfang hinzu (für umgekehrte Reihenfolge)
  storedMessages.unshift({ text: messageWithTimestamp, isError, isWarning });

  // Speichere die aktualisierten Nachrichten
  saveToLocalStorage('csvMessages', JSON.stringify(storedMessages));

  // Aktualisiere das UI mit der entsprechenden Klasse
  csvMessageDiv.innerHTML = storedMessages
    .map(msg => `<p class="${msg.isWarning ? 'warning' : msg.isError ? 'error' : 'success'}">${msg.text}</p>`)
    .join('');


  // Scrolle zum Ende des Message-Divs
  csvMessageDiv.scrollTop = csvMessageDiv.scrollHeight;
}


// Hilfsfunktionen
const parseCSVLine = (line) => {
  // Einfacher CSV-Parser für das neue Format mit Kommas als Trennzeichen
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

const saveToLocalStorage = (key, value) => localStorage.setItem(key, value);
const getFromLocalStorage = (key) => localStorage.getItem(key) || '';
const createTableHTML = (headers, bodyId) => `
  <table class="csv-table">
    <thead><tr>${headers.map(h => `<th class="sortable">${h}</th>`).join('')}</tr></thead>
    <tbody id="${bodyId}"></tbody>
  </table>
`;

// Neue Funktion zum Speichern des Plans (inkl. Räume)
function speicherePlan() {
  if (state.aktuellerPlan) {
    localStorage.setItem('planDaten', JSON.stringify({
      aktuellerPlan: state.aktuellerPlan,
      anwesendeLehrer: Array.from(state.anwesendeLehrer),
      bevorzugteFaecher: Array.from(state.bevorzugteFaecher),
      raeume: state.raeume
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

  // Aktualisiere state.anwesendeLehrer
  state.anwesendeLehrer = new Set(selectedLehrer);

  const auswahl = {
    selectedKlassen,
    selectedLehrer,
    jahrgangEinträge
  };
  saveToLocalStorage('auswahlDaten', JSON.stringify(auswahl));
}

function ladeAuswahl() {
  const gespeicherteAuswahl = getFromLocalStorage('auswahlDaten');
  let selectedKlassen = [];
  let selectedLehrer = [];
  let jahrgangEinträge = {};

  if (gespeicherteAuswahl) {
    try {
      const auswahl = JSON.parse(gespeicherteAuswahl);
      // Filtere nur gültige Klassen und Lehrer
      selectedKlassen = auswahl.selectedKlassen.filter(k => state.klassenMap[k]);
      selectedLehrer = auswahl.selectedLehrer.filter(l => state.lehrerSet.has(l));
      jahrgangEinträge = auswahl.jahrgangEinträge || {};
      // Bereinige Jahrgangseinträge für nicht existierende Klassen
      jahrgangEinträge = Object.fromEntries(
        Object.entries(jahrgangEinträge).filter(([klasse]) => state.klassenMap[klasse])
      );
    } catch (e) {
      console.error('Fehler beim Parsen der gespeicherten Auswahl-Daten:', e);
      localStorage.removeItem('auswahlDaten'); // Entferne ungültige Daten
    }
  }

  // Wenn keine gespeicherten Auswahldaten vorhanden sind, wähle alle Klassen und Lehrer aus
  if (selectedKlassen.length === 0 && Object.keys(state.klassenMap).length > 0) {
    selectedKlassen = Object.keys(state.klassenMap);
  }
  if (selectedLehrer.length === 0 && state.lehrerSet.size > 0) {
    selectedLehrer = Array.from(state.lehrerSet);
  }

  // Klassen-Checkboxen
  document.querySelectorAll('.klasseCheckbox').forEach(cb => {
    if (state.klassenMap[cb.value]) {
      cb.checked = selectedKlassen.includes(cb.value);
    } else {
      cb.checked = false; // Sicherstellen, dass nicht existierende Klassen abgewählt sind
    }
  });

  // Lehrer-Checkboxen
  document.querySelectorAll('.lehrerCheckbox').forEach(cb => {
    if (state.lehrerSet.has(cb.value)) {
      cb.checked = selectedLehrer.includes(cb.value);
    } else {
      cb.checked = false; // Sicherstellen, dass nicht existierende Lehrer abgewählt sind
    }
  });

  // Jahrgangseinträge
  Object.entries(jahrgangEinträge).forEach(([klasse, jahrgang]) => {
    if (state.klassenMap[klasse]) {
      state.klassenMap[klasse].manuellerJahrgang = jahrgang;
      const input = document.querySelector(`.jahrgang-input[data-klasse="${klasse}"] .jahrgangInput`);
      if (input) {
        input.value = jahrgang;
      }
    }
  });

  // Aktualisiere state.anwesendeLehrer basierend auf der Auswahl
  state.anwesendeLehrer = new Set(selectedLehrer);

  // Speichere die bereinigte Auswahl
  speichereAuswahl();
}



// Datenmanagement
async function ladeGespeicherteCSV(changedFile = null) {
  // Temporäre Sets für Klassen, Lehrer und Fächer
  const neueKlassen = new Set();
  const neueLehrer = new Set();
  const neueFaecher = new Set();

  state.aktuellerPlan = null; // Initial auf null setzen
  state.anwesendeLehrer = new Set(); // Initial leeren
  state.bevorzugteFaecher = new Set(); // Initial leeren

  // Verarbeitung der Unterrichts-CSV (mit Leeren der Sets vor dem Parsen)
  const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
  let unterrichtError = false;
  if (unterrichtCSV) {
    // WICHTIG: Leere alle lehrerSets und lehrerFaecher, bevor neu geparst wird
    Object.values(state.klassenMap).forEach(kl => {
      kl.lehrerSet.clear();
      kl.lehrerFaecher.clear();
    });

    const lines = unterrichtCSV.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      if (changedFile === 'unterricht') {
        addStatusMessage('Unterrichts-Datei enthält keine Datenzeilen.', true);
      }
      state.unterrichtLoaded = false;
      unterrichtError = true;
    } else {
      // Parse Header-Zeile und finde Spalten-Indizes
      const headerColumns = parseCSVLine(lines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const fachIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fach');
      const lehrkraftIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'lehrkraft');
      const fachgruppeIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fachgruppe');

      // Überprüfe, ob alle benötigten Spalten gefunden wurden
      if (klasseIndex === -1 || fachIndex === -1 || lehrkraftIndex === -1) {
        if (changedFile === 'unterricht') {
          const missingColumns = [];
          if (klasseIndex === -1) missingColumns.push('Klasse');
          if (fachIndex === -1) missingColumns.push('Fach');
          if (lehrkraftIndex === -1) missingColumns.push('Lehrkraft');
          addStatusMessage(`Fehler beim Laden der Unterrichts-Datei: Spalten ${missingColumns.join(', ')} nicht gefunden.`, true);
        }
        state.unterrichtLoaded = false;
        unterrichtError = true;
      } else {
        // Verarbeite Datenzeilen
        let validRows = 0;
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const columns = parseCSVLine(line);

          const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
          const fach = columns[fachIndex] ? columns[fachIndex].replace(/"/g, '').trim() : '';
          const lehrkraft = columns[lehrkraftIndex] ? columns[lehrkraftIndex].replace(/"/g, '').trim() : '';
          const fachgruppe = fachgruppeIndex !== -1 ? (columns[fachgruppeIndex] ? columns[fachgruppeIndex].replace(/"/g, '').trim() : '') : '';

          if (!klasse || !fach || !lehrkraft) {
            if (changedFile === 'unterricht') {
              addStatusMessage(`Ungültige Daten in Unterrichts-CSV, Zeile ${i + 1}: Klasse, Fach oder Lehrkraft fehlt oder ist ungültig.`, false, true); // isWarning = true
            }
            continue;
          }

          neueFaecher.add(fach);
          neueKlassen.add(klasse);
          neueLehrer.add(lehrkraft);

          if (!state.klassenMap[klasse]) {
            state.klassenMap[klasse] = {
              name: klasse,
              kl: null,
              lehrerSet: new Set(),
              lehrerFaecher: new Map(),
              manuellerJahrgang: null,
            };
          }

          state.klassenMap[klasse].lehrerSet.add(lehrkraft);
          if (!state.klassenMap[klasse].lehrerFaecher.has(lehrkraft)) {
            state.klassenMap[klasse].lehrerFaecher.set(lehrkraft, new Set());
          }
          state.klassenMap[klasse].lehrerFaecher.get(lehrkraft).add(fach);
          validRows++;
        }
        state.unterrichtLoaded = validRows > 0;
        if (changedFile === 'unterricht' && validRows > 0) {
          addStatusMessage('Unterricht erfolgreich geladen.');
        } else if (changedFile === 'unterricht' && validRows === 0) {
          addStatusMessage('Unterrichts-Datei enthält keine gültigen Datenzeilen.', true);
          state.unterrichtLoaded = false;
          unterrichtError = true;
        }
      }
    }
  } else {
    state.unterrichtLoaded = false;
    if (changedFile === 'unterricht') {
      addStatusMessage('Keine Unterrichts-CSV-Daten vorhanden.', true);
      unterrichtError = true;
    }
  }

  // Verarbeitung der Klassenleiter-CSV (mit Leeren der kl-Werte vor dem Parsen)
  const klassenleiterCSV = getFromLocalStorage('klassenleiterCSV');
  if (klassenleiterCSV) {
    // WICHTIG: Leere alle kl-Werte, bevor neu geparst wird
    Object.values(state.klassenMap).forEach(kl => {
      kl.kl = null;
    });

    const lines = klassenleiterCSV.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      if (changedFile === 'klassenleiter') {
        addStatusMessage('Klassenleiter-Datei enthält keine Datenzeilen.', true);
      }
      state.klassenleiterLoaded = false;
    } else {
      // Parse Header-Zeile und finde Spalten-Indizes
      const headerColumns = parseCSVLine(lines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const klassenleitungIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klassenleitung');

      // Überprüfe, ob alle benötigten Spalten gefunden wurden
      if (klasseIndex === -1 || klassenleitungIndex === -1) {
        if (changedFile === 'klassenleiter') {
          const missingColumns = [];
          if (klasseIndex === -1) missingColumns.push('Klasse');
          if (klassenleitungIndex === -1) missingColumns.push('Klassenleitung');
          addStatusMessage(`Fehler beim Laden der Klassenleiter-Datei: Spalten ${missingColumns.join(', ')} nicht gefunden.`, true);
        }
        state.klassenleiterLoaded = false;
      } else {
        // Überprüfung auf doppelte Klassen
        const klassenGesehen = new Set();
        const doppelteKlassen = new Set();
        let validRows = 0;

        // Verarbeite Datenzeilen
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const columns = parseCSVLine(line);

          const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
          const klassenleitung = columns[klassenleitungIndex] ? columns[klassenleitungIndex].replace(/"/g, '').trim() : '';

          if (!klasse || !klassenleitung) {
            if (changedFile === 'klassenleiter') {
              addStatusMessage(`Ungültige Daten in Klassenleiter-Datei, Zeile ${i + 1}: Klasse oder Klassenleitung fehlt oder ist ungültig.`, false, true);
            }
            continue;
          }

          // Überprüfe auf doppelte Klassen
          if (klassenGesehen.has(klasse)) {
            doppelteKlassen.add(klasse);
          } else {
            klassenGesehen.add(klasse);
          }

          neueKlassen.add(klasse);
          neueLehrer.add(klassenleitung);

          if (!state.klassenMap[klasse]) {
            state.klassenMap[klasse] = {
              name: klasse,
              kl: null,
              lehrerSet: new Set(),
              lehrerFaecher: new Map(),
              manuellerJahrgang: null,
            };
          }
          state.klassenMap[klasse].kl = klassenleitung;
          validRows++;
        }

        // Warnung für doppelte Klassen
        if (doppelteKlassen.size > 0 && changedFile === 'klassenleiter') {
          addStatusMessage(`Folgende Klassen kommen in der Klassenleiter-Datei mehrfach vor: ${Array.from(doppelteKlassen).join(', ')}. Nur die letzte Zuordnung wird verwendet.`, false, true);
        }

        state.klassenleiterLoaded = validRows > 0;
        if (changedFile === 'klassenleiter' && validRows > 0) {
          addStatusMessage('Klassenleiter erfolgreich geladen.');
        } else if (changedFile === 'klassenleiter' && validRows === 0) {
          addStatusMessage('Klassenleiter enthält keine gültigen Datenzeilen.', true);
          state.klassenleiterLoaded = false;
        }
      }
    }
  } else {
    state.klassenleiterLoaded = false;
    if (changedFile === 'klassenleiter') {
      addStatusMessage('Keine Klassenleiter-Daten vorhanden.', true);
    }
  }


  // Bereinige state.klassenMap: Entferne Klassen, die nicht mehr in den CSV-Dateien existieren
  Object.keys(state.klassenMap).forEach(klasse => {
    if (!neueKlassen.has(klasse)) {
      delete state.klassenMap[klasse];
    }
  });

  // Aktualisiere state.lehrerSet: Nur Lehrer, die in den CSV-Dateien vorkommen
  state.lehrerSet.clear();
  neueLehrer.forEach(lehrer => state.lehrerSet.add(lehrer));

  // Aktualisiere state.faecherSet
  state.faecherSet.clear();
  neueFaecher.forEach(fach => state.faecherSet.add(fach));

  // Lade gespeicherte Plan-Daten (inkl. Räume)
  const gespeichertePlanDaten = getFromLocalStorage('planDaten');
  if (gespeichertePlanDaten) {
    try {
      const planDaten = JSON.parse(gespeichertePlanDaten);
      state.aktuellerPlan = planDaten.aktuellerPlan;
      state.anwesendeLehrer = new Set(planDaten.anwesendeLehrer || []);
      state.bevorzugteFaecher = new Set(planDaten.bevorzugteFaecher || []);
      state.raeume = planDaten.raeume || [];
    } catch (e) {
      console.error('Fehler beim Parsen der gespeicherten Plan-Daten:', e);
      localStorage.removeItem('planDaten'); // Entferne ungültige Daten
      if (changedFile) {
        addStatusMessage('Fehler beim Laden gespeicherter Plan-Daten.', true);
      }
    }
  }

  // Bereinige anwesende Lehrer und bevorzugte Fächer
  state.anwesendeLehrer = new Set([...state.anwesendeLehrer].filter(l => state.lehrerSet.has(l)));
  state.bevorzugteFaecher = new Set([...state.bevorzugteFaecher].filter(f => state.faecherSet.has(f)));

  updateUI();
  ladeAuswahl(); // Aktualisiere die Auswahl nach dem Laden der CSV-Daten
}

// UI-Handling
async function zeigeCSVBearbeitung() {
  const loadingIndicator = document.getElementById('loadingIndicator');
  if (loadingIndicator) loadingIndicator.classList.add('active');

  const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
  const klassenleiterCSV = getFromLocalStorage('klassenleiterCSV');
  const csvTablesSection = document.getElementById('csvTablesSection');
  const klassenleiterCSVSection = document.getElementById('klassenleiterCSVSection');

  // Unterrichts-CSV Tabelle
  const unterrichtTable = document.getElementById('unterrichtCSVTable');
  const addUnterrichtRow = document.getElementById('addUnterrichtRow');
  const saveUnterrichtCSV = document.getElementById('saveUnterrichtCSV');

  if (unterrichtTable) {
    // Zeige csvTablesSection immer an, um den Hinweistext anzuzeigen
    if (csvTablesSection) {
      csvTablesSection.classList.remove('hidden');
    }

    if (unterrichtCSV && state.unterrichtLoaded) {
      const unterrichtLines = unterrichtCSV.split('\n').filter(line => line.trim());

      if (unterrichtLines.length < 2) return;

      // Parse Header und finde Spalten-Indizes
      const headerColumns = parseCSVLine(unterrichtLines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const fachIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fach');
      const lehrkraftIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'lehrkraft');
      const fachgruppeIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'fachgruppe');

      if (klasseIndex === -1 || fachIndex === -1 || lehrkraftIndex === -1) {
        unterrichtTable.innerHTML = '<p class="no-data-hint">Fehler: Benötigte Spalten (Klasse, Fach, Lehrkraft) nicht gefunden.</p>';
        return;
      }

      // Bestimme Header basierend auf vorhandener Fachgruppe-Spalte
      const headers = ['Klasse', 'Fach', 'Lehrkraft'];
      let hasFachgruppe = false;
      if (fachgruppeIndex !== -1) {
        headers.splice(1, 0, 'Fachgruppe'); // Füge nach Klasse ein
        hasFachgruppe = true;
      }
      headers.push('Aktion');
      unterrichtTable.innerHTML = createTableHTML(headers, 'unterrichtCSVBody');
      const unterrichtBody = document.getElementById('unterrichtCSVBody');

      // Verarbeite die Daten und zeige sie in vereinfachter Form
      const processedData = [];
      for (let i = 1; i < unterrichtLines.length; i++) {
        const line = unterrichtLines[i];
        const columns = parseCSVLine(line);

        const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
        const fach = columns[fachIndex] ? columns[fachIndex].replace(/"/g, '').trim() : '';
        const lehrkraft = columns[lehrkraftIndex] ? columns[lehrkraftIndex].replace(/"/g, '').trim() : '';
        const fachgruppe = fachgruppeIndex !== -1 ? (columns[fachgruppeIndex] ? columns[fachgruppeIndex].replace(/"/g, '').trim() : '') : '';

        if (klasse && fach && lehrkraft) {
          processedData.push({ klasse, fachgruppe, fach, lehrkraft, originalIndex: i });
        }
      }

      // Sortiere processedData zunächst nach originalIndex für Konsistenz
      processedData.sort((a, b) => a.originalIndex - b.originalIndex);

      unterrichtBody.innerHTML = processedData.map((data, index) => {
        const rowFields = ['klasse'];
        if (hasFachgruppe) {
          rowFields.push('fachgruppe');
        }
        rowFields.push('fach', 'lehrkraft');
        return `
    <tr data-row-id="${data.originalIndex}">
      ${rowFields.map(field => `<td><input type="text" value="${data[field] || ''}" data-row="${data.originalIndex}" data-field="${field}" placeholder="${field.charAt(0).toUpperCase() + field.slice(1)}"></td>`).join('')}
      <td><button class="delete-row-btn" data-row="${data.originalIndex}" data-table="unterricht">Löschen</button></td>
    </tr>
  `;
      }).join('');

      // Buttons sichtbar machen
      if (addUnterrichtRow) addUnterrichtRow.style.display = 'inline-block';
      if (saveUnterrichtCSV) saveUnterrichtCSV.style.display = 'inline-block';

      // Sortier-Listener für Unterrichtstabelle hinzufügen
      const sortableFields = ['klasse'];
      if (hasFachgruppe) {
        sortableFields.push('fachgruppe');
      }
      sortableFields.push('fach', 'lehrkraft');
      addSortListeners('unterrichtCSVBody', sortableFields);
    } else {
      unterrichtTable.innerHTML = '<p class="no-data-hint">Bitte laden Sie die Unterrichts-Daten hoch, um die Daten anzuzeigen.</p>';
      // Buttons ausblenden
      if (addUnterrichtRow) addUnterrichtRow.style.display = 'none';
      if (saveUnterrichtCSV) saveUnterrichtCSV.style.display = 'none';
    }
  }

  // Klassenleiter-CSV Tabelle (bleibt unverändert)
  const klassenleiterTable = document.getElementById('klassenleiterCSVTable');
  const addKlassenleiterRow = document.getElementById('addKlassenleiterRow');
  const saveKlassenleiterCSV = document.getElementById('saveKlassenleiterCSV');

  if (klassenleiterTable) {
    // Zeige klassenleiterCSVSection immer an, um den Hinweistext anzuzeigen
    if (klassenleiterCSVSection) {
      klassenleiterCSVSection.classList.remove('hidden');
    }

    if (klassenleiterCSV && state.klassenleiterLoaded) {
      klassenleiterTable.innerHTML = createTableHTML(['Klasse', 'Klassenleitung', 'Aktion'], 'klassenleiterCSVBody');
      const klassenleiterBody = document.getElementById('klassenleiterCSVBody');
      const klassenleiterLines = klassenleiterCSV.split('\n').filter(line => line.trim());

      if (klassenleiterLines.length < 2) return;

      // Parse Header und finde Spalten-Indizes
      const headerColumns = parseCSVLine(klassenleiterLines[0]);
      const klasseIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klasse');
      const klassenleitungIndex = headerColumns.findIndex(col => col.replace(/"/g, '').trim().toLowerCase() === 'klassenleitung');

      if (klasseIndex === -1 || klassenleitungIndex === -1) {
        klassenleiterTable.innerHTML = '<p class="no-data-hint">Fehler: Benötigte Spalten (Klasse, Klassenleitung) nicht gefunden.</p>';
        return;
      }

      // Verarbeite die Daten und zeige sie in vereinfachter Form
      const processedKlassenleiterData = [];
      for (let i = 1; i < klassenleiterLines.length; i++) {
        const line = klassenleiterLines[i];
        const columns = parseCSVLine(line);

        const klasse = columns[klasseIndex] ? columns[klasseIndex].replace(/"/g, '').trim() : '';
        const klassenleitung = columns[klassenleitungIndex] ? columns[klassenleitungIndex].replace(/"/g, '').trim() : '';

        if (klasse && klassenleitung) {
          processedKlassenleiterData.push({ klasse, klassenleitung, originalIndex: i });
        }
      }

      // Sortiere processedKlassenleiterData zunächst nach originalIndex für Konsistenz
      processedKlassenleiterData.sort((a, b) => a.originalIndex - b.originalIndex);

      klassenleiterBody.innerHTML = processedKlassenleiterData.map((data, index) => {
        return `
    <tr data-row-id="${data.originalIndex}">
      <td><input type="text" value="${data.klasse}" data-row="${data.originalIndex}" data-field="klasse" placeholder="Klasse"></td>
      <td><input type="text" value="${data.klassenleitung}" data-row="${data.originalIndex}" data-field="klassenleitung" placeholder="Klassenleitung"></td>
      <td><button class="delete-row-btn" data-row="${data.originalIndex}" data-table="klassenleiter">Löschen</button></td>
    </tr>
  `;
      }).join('');

      // Buttons sichtbar machen
      if (addKlassenleiterRow) addKlassenleiterRow.style.display = 'inline-block';
      if (saveKlassenleiterCSV) saveKlassenleiterCSV.style.display = 'inline-block';

      // Sortier-Listener für Klassenleiter-Tabelle hinzufügen
      addSortListeners('klassenleiterCSVBody', ['klasse', 'klassenleitung']);
    } else {
      klassenleiterTable.innerHTML = '<p class="no-data-hint">Bitte laden Sie die Klassenleiter-Daten hoch, um die Daten anzuzeigen.</p>';
      // Buttons ausblenden
      if (addKlassenleiterRow) addKlassenleiterRow.style.display = 'none';
      if (saveKlassenleiterCSV) saveKlassenleiterCSV.style.display = 'none';
    }
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  if (loadingIndicator) loadingIndicator.classList.remove('active');

  // Event-Listener für Lösch-Buttons
  addDeleteRowListeners();
}

// Neue Funktion für Sortier-Listener
function addSortListeners(bodyId, sortableFields) {
  const table = document.querySelector(`#${bodyId}`).closest('table');
  const headers = table.querySelectorAll('th.sortable');
  let sortDirections = {}; // Speichert die Sortierrichtung pro Feld

  headers.forEach((header, index) => {
    if (index < sortableFields.length) { // Nur für sortierbare Felder
      const field = sortableFields[index];
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        const tbody = document.getElementById(bodyId);
        const rows = Array.from(tbody.querySelectorAll('tr'));

        // Toggle Sortierrichtung
        sortDirections[field] = sortDirections[field] === 'asc' ? 'desc' : 'asc';
        const direction = sortDirections[field];

        // Sortiere Zeilen
        rows.sort((a, b) => {
          const aValue = a.querySelector(`input[data-field="${field}"]`)?.value.toLowerCase() || '';
          const bValue = b.querySelector(`input[data-field="${field}"]`)?.value.toLowerCase() || '';
          if (direction === 'asc') {
            return aValue.localeCompare(bValue);
          } else {
            return bValue.localeCompare(aValue);
          }
        });

        // Leere tbody und füge sortierte Zeilen hinzu
        tbody.innerHTML = '';
        rows.forEach(row => tbody.appendChild(row));

        // Aktualisiere Event-Listener für neue Lösch-Buttons
        addDeleteRowListeners();

        // Visuelle Indikatoren (optional: Pfeile hinzufügen)
        headers.forEach(h => h.innerHTML = h.innerHTML.replace(/ [↑↓]/, '')); // Entferne alte Pfeile
        header.innerHTML += direction === 'asc' ? ' ↑' : ' ↓';
      });
    }
  });
}

function updateUI() {
  const optionen = document.getElementById('optionen');
  if (optionen) {
    optionen.style.display = 'block';

    // Planung-Tab nur anzeigen, wenn beide CSV-Dateien geladen sind
    const planungTab = document.getElementById('planungTab');
    if (planungTab) {
      if (state.unterrichtLoaded) {
        planungTab.classList.remove('hidden');
      } else {
        planungTab.classList.add('hidden');
      }
    }

    const kCont = document.getElementById('klassenContainer');
    if (kCont) {
      if (Object.keys(state.klassenMap).length > 0) {
        kCont.innerHTML = Object.keys(state.klassenMap).sort().map(k => {
          const hatZahl = k.match(/^(\d+)/);
          const jahrgang = state.klassenMap[k].manuellerJahrgang || '';
          return `
            <label>
              <input type="checkbox" class="klasseCheckbox" value="${k}" checked> ${k}
              <span class="jahrgang-input" data-klasse="${k}" style="display:${hatZahl ? 'none' : 'inline-block'};">
                <input type="number" class="jahrgangInput" min="1" max="13" value="${jahrgang}" placeholder="Jahrgang">
              </span>
            </label>`;
        }).join('');
      } else {
        kCont.innerHTML = '<p>Keine Klassen verfügbar. Bitte importieren Sie die Dateien.</p>';
      }
    }

    const lCont = document.getElementById('lehrerContainer');
    if (lCont) {
      if (state.lehrerSet.size > 0) {
        lCont.innerHTML = Array.from(state.lehrerSet).sort().map(l => `
          <label><input type="checkbox" class="lehrerCheckbox" value="${l}" checked> ${l}</label>
        `).join('');
      } else {
        lCont.innerHTML = '<p>Keine Lehrer verfügbar. Bitte importieren Sie die Dateien.</p>';
      }
    }

    // Lade gespeicherte Auswahl (inkl. Jahrgangseinträge)
    ladeAuswahl();

    ladePlanungsoptionen();
    updateFaecherUI();
    updateRaeumeUI(); // Neue Funktion für Räume
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = state.aktuellerPlan ? 'block' : 'none';
    const exportLehrerBtn = document.getElementById('exportLehrerBtn');
    if (exportLehrerBtn) exportLehrerBtn.style.display = state.aktuellerPlan ? 'block' : 'none';
    toggleJahrgangInputs();
    zeigeCSVBearbeitung();
  } else {
    console.error("Element mit ID 'optionen' wurde nicht gefunden.");
  }
}

// Neue Funktion: Räume-UI aktualisieren
function updateRaeumeUI() {
  const maxKlassenProSlot = parseInt(document.getElementById('maxKlassenProSlot')?.value) || 5;
  const raeumeInputs = document.getElementById('raeumeInputs');
  if (raeumeInputs) {
    // FIX: Kürze state.raeume auf die neue Länge und initialisiere leere Einträge
    state.raeume.length = maxKlassenProSlot; // Kürzt oder erweitert das Array
    for (let i = 0; i < maxKlassenProSlot; i++) {
      if (state.raeume[i] === undefined) state.raeume[i] = ''; // Neu: Stelle sicher, dass es leer ist
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
}

function addDeleteRowListeners() {
  document.querySelectorAll('.delete-row-btn').forEach(button => {
    const newButton = button.cloneNode(true); // Klone Button ohne Event-Listener
    button.parentNode.replaceChild(newButton, button); // Ersetze alten Button
    newButton.addEventListener('click', (e) => {
      const rowId = parseInt(e.target.dataset.row);
      const table = e.target.dataset.table;
      deleteRow(rowId, table);
    });
  });
}


function deleteRow(rowId, table) {
  const storageKey = table === 'unterricht' ? 'unterrichtCSV' : 'klassenleiterCSV';
  const csv = getFromLocalStorage(storageKey);
  if (!csv) return;

  const lines = csv.split('\n').filter(line => line.trim());
  lines.splice(rowId, 1); // Entferne die Zeile
  saveToLocalStorage(storageKey, lines.join('\n'));

  // Aktualisiere die Tabelle und den Zustand
  ladeGespeicherteCSV();
  zeigeCSVBearbeitung();
  alert(`Zeile ${rowId + 1} aus ${table === 'unterricht' ? 'Unterrichts-CSV' : 'Klassenleiter-CSV'} gelöscht.`);
}

function addTableRow(tableBodyId, fields, rowId) {
  const tableBody = document.getElementById(tableBodyId);
  if (tableBody) {
    tableBody.innerHTML += `
      <tr data-row-id="${rowId}">
        ${fields.map(field => `<td><input type="text" value="" data-row="${rowId}" data-field="${field}" placeholder="${field.charAt(0).toUpperCase() + field.slice(1)}"></td>`).join('')}
        <td><button class="delete-row-btn" data-row="${rowId}" data-table="${tableBodyId.includes('unterricht') ? 'unterricht' : 'klassenleiter'}">Löschen</button></td>
      </tr>
    `;
    // Event-Listener für neuen Lösch-Button hinzufügen
    addDeleteRowListeners();
  }
}

function saveCSV(tableBodyId, storageKey, fields, alertMessage) {
  console.log(`saveCSV: Starte Speichern für ${tableBodyId}, storageKey: ${storageKey}`);

  const rows = Array.from(document.querySelectorAll(`#${tableBodyId} tr`)).sort(
    (a, b) => parseInt(a.dataset.rowId) - parseInt(b.dataset.rowId)
  );
  console.log(`saveCSV: ${rows.length} Zeilen gefunden`);

  // Überprüfung auf doppelte Klassen (nur für Klassenleiter-Tabelle)
  if (storageKey === 'klassenleiterCSV') {
    const klassenGesehen = new Set();
    const doppelteKlassen = new Set();

    rows.forEach((row, index) => {
      const klasseInput = row.querySelector('input[data-field="klasse"]');
      if (!klasseInput) {
        console.error(`Kein Eingabefeld für 'klasse' in Zeile ${index} (rowId: ${row.dataset.rowId})`);
        return;
      }
      const klasse = klasseInput.value.trim();
      if (klasse) {
        if (klassenGesehen.has(klasse)) {
          doppelteKlassen.add(klasse);
        } else {
          klassenGesehen.add(klasse);
        }
      }
    });

    if (doppelteKlassen.size > 0) {
      const warningMessage = `Folgende Klassen kommen in der Klassenleiter-Tabelle mehrfach vor: ${Array.from(doppelteKlassen).join(
        ', '
      )}. Bitte korrigieren Sie die Eingaben, bevor Sie speichern.`;
      addStatusMessage(warningMessage, false, true);
      console.log(`saveCSV: Abbruch wegen doppelter Klassen: ${Array.from(doppelteKlassen).join(', ')}`);
      alert(warningMessage); // Zeige Alert für doppelte Klassen
      return; // Verhindere das Speichern
    }
  }

  // Generiere CSV-Zeilen
  const csvLines = rows
    .map((row, index) => {
      try {
        const rowData = fields.map(field => {
          const input = row.querySelector(`input[data-field="${field}"]`);
          if (!input) {
            console.warn(`Kein Eingabefeld für "${field}" in Zeile ${index} (rowId: ${row.dataset.rowId})`);
            return '""';
          }
          const value = input.value.trim().replace(/"/g, '""'); // Escape Anführungszeichen
          return `"${value}"`;
        });
        const line = rowData.join(',');
        // Prüfe, ob die Zeile gültige Daten enthält (mindestens ein Feld nicht leer)
        return rowData.some(val => val !== '""') ? line : null;
      } catch (error) {
        console.error(`Fehler beim Verarbeiten von Zeile ${index} (rowId: ${row.dataset.rowId}):`, error);
        return null;
      }
    })
    .filter(line => line); // Entferne ungültige oder leere Zeilen

  console.log(`saveCSV: Generierte CSV-Zeilen:`, csvLines);

  // Erstelle die finale CSV-Datei mit dynamischem Header für Unterricht
  let header;
  if (storageKey === 'unterrichtCSV') {
    if (fields.includes('fachgruppe')) {
      header = '"Klasse","Fachgruppe","Fach","Lehrkraft"';
    } else {
      header = '"Klasse","Fach","Lehrkraft"';
    }
  } else {
    header = '"Klasse","Klassenleitung"';
  }
  const finalCSV = csvLines.length > 0 ? [header, ...csvLines].join('\n') : header;
  console.log(`saveCSV: Finale CSV:`, finalCSV);

  // Speichere die CSV-Daten
  saveToLocalStorage(storageKey, finalCSV);

  // Aktualisiere den Zustand und die UI
  ladeGespeicherteCSV().then(() => {
    zeigeCSVBearbeitung().then(() => {
      updateUI();
      ladeAuswahl();
      console.log(`saveCSV: ${alertMessage}`);
      addStatusMessage(alertMessage); // Protokolliere Erfolgsmeldung
      alert(alertMessage); // Zeige Alert für erfolgreiches Speichern
    });
  }).catch(error => {
    const errorMessage = `Fehler beim Speichern der ${storageKey === 'unterrichtCSV' ? 'Unterrichts' : 'Klassenleiter'
      }-Daten: ${error.message}`;
    console.error(`saveCSV: Fehler beim Aktualisieren nach Speichern:`, error);
    addStatusMessage(errorMessage, true);
    alert(errorMessage); // Zeige Alert für Fehler
  });
}

function activateTab(tabId) {
  document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  const tabButton = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
  if (tabButton) tabButton.classList.add('active');
  const tabContent = document.getElementById(tabId);
  if (tabContent) tabContent.classList.add('active');
}

function toggleJahrgangInputs() {
  const einerProJahrgang = document.getElementById('einerProJahrgang');
  if (!einerProJahrgang) return;
  const showInputs = einerProJahrgang.checked;
  document.querySelectorAll('.jahrgang-input').forEach(span => {
    const klasse = span.dataset.klasse;
    if (!klasse.match(/^(\d+)/)) {
      span.style.display = showInputs ? 'inline-block' : 'none';
    }
  });
}
function setHasAny(setA, setB) {
  for (const elem of setB) {
    if (setA.has(elem)) return true;
  }
  return false;
}

// Modifizierte Planungsfunktion mit Raumzuweisung
function versuchePlanung(maxSlots, maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, selectedKlassen) {
  const belegung = Array(maxSlots).fill().map(() => new Set());
  const plan = Array(maxSlots).fill().map(() => []);
  const warnungen = [];

  const klassenListe = selectedKlassen.map(name => state.klassenMap[name]).sort((a, b) => {
    const lehrerMitBevorzugtemFachA = Array.from(a.lehrerSet).filter(l =>
      state.anwesendeLehrer.has(l) && setHasAny(a.lehrerFaecher.get(l) || new Set(), state.bevorzugteFaecher)
    ).length;
    const lehrerMitBevorzugtemFachB = Array.from(b.lehrerSet).filter(l =>
      state.anwesendeLehrer.has(l) && setHasAny(b.lehrerFaecher.get(l) || new Set(), state.bevorzugteFaecher)
    ).length;
    return lehrerMitBevorzugtemFachB - lehrerMitBevorzugtemFachA;
  });

  for (let i = klassenListe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [klassenListe[i], klassenListe[j]] = [klassenListe[j], klassenListe[i]];
  }

  const zuweisungen = new Map(klassenListe.map(klasse => [klasse.name, []]));
  klassenListe.forEach(klasse => {
    const jahrgang = klasse.manuellerJahrgang || klasse.name.match(/^(\d+)/)?.[1] || null;
    const klassenleiter = klasse.kl;
    const lehrerDerKlasse = Array.from(klasse.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
    const mindAnwesend = Math.ceil(klasse.lehrerSet.size * anwesendQuote);

    // Prüfe, ob Klassenleiterpflicht aktiviert ist und Klassenleiter verfügbar ist
    if (klassenleiterPflicht) {
      if (!klassenleiter) {
        warnungen.push(`Klasse ${klasse.name} hat keinen Klassenleiter zugeordnet. Klasse wird nicht verplant (Klassenleiterpflicht aktiviert).`);
        return; // Klasse nicht verplanen
      }
      if (!state.anwesendeLehrer.has(klassenleiter) || !klasse.lehrerSet.has(klassenleiter)) {
        warnungen.push(`Klassenleiter ${klassenleiter} der Klasse ${klasse.name} ist nicht anwesend oder unterrichtet nicht in dieser Klasse. Klasse wird nicht verplant (Klassenleiterpflicht aktiviert).`);
        return; // Klasse nicht verplanen
      }
    }

    const möglicheSlots = Array.from({ length: maxSlots }, (_, i) => i);
    if (klassenleiterPflicht && klassenleiter && state.anwesendeLehrer.has(klassenleiter)) {
      möglicheSlots.sort((a, b) => (belegung[a].has(klassenleiter) ? 1 : 0) - (belegung[b].has(klassenleiter) ? 1 : 0));
    } else {
      for (let i = möglicheSlots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [möglicheSlots[i], möglicheSlots[j]] = [möglicheSlots[j], möglicheSlots[i]];
      }
    }

    let slotGefunden = false;
    for (const slot of möglicheSlots) {
      if (plan[slot].length >= maxKlassenProSlot) continue;
      const besetzt = belegung[slot];
      const slotJahrgaenge = plan[slot].map(p => p.jahrgang);

      if (einerProJahrgang && jahrgang && slotJahrgaenge.includes(jahrgang)) continue;

      const verfügbare = lehrerDerKlasse.filter(l => !besetzt.has(l));
      if (verfügbare.length < mindAnwesend) continue;

      let auszuwählen = [];
      if (klassenleiterPflicht && klassenleiter && verfügbare.includes(klassenleiter)) {
        auszuwählen.push(klassenleiter);
      } else if (klassenleiterPflicht && klassenleiter) {
        continue;
      }

      // Entferne den Klassenleiter aus der Liste der restlichen Lehrer, um Dopplung zu vermeiden
const restlicheLehrer = verfügbare.filter(l => l !== klassenleiter).sort((a, b) => {
  const faecherA = klasse.lehrerFaecher.get(a) || new Set();
  const faecherB = klasse.lehrerFaecher.get(b) || new Set();
  
  // Prüfe ob mindestens EIN bevorzugtes Fach unterrichtet wird
  const hatBevorzugtesFachA = setHasAny(faecherA, state.bevorzugteFaecher);
  const hatBevorzugtesFachB = setHasAny(faecherB, state.bevorzugteFaecher);
  
  // Lehrer mit bevorzugten Fächern zuerst
  if (hatBevorzugtesFachA && !hatBevorzugtesFachB) return -1;
  if (!hatBevorzugtesFachA && hatBevorzugtesFachB) return 1;
  
  // Bei Gleichstand: Zufällig
  return Math.random() - 0.5;
});

      const benötigteLehrer = mindAnwesend - (klassenleiterPflicht && klassenleiter && verfügbare.includes(klassenleiter) ? 1 : 0);
      auszuwählen = auszuwählen.concat(restlicheLehrer.slice(0, benötigteLehrer));
      // Raumzuweisung: Nimm den nächsten verfügbaren Raum im Slot (zyklisch, aber einzigartig)
      const raumIndex = plan[slot].length % state.raeume.length;
      const raum = state.raeume[raumIndex] || `Raum ${raumIndex + 1}`;
      plan[slot].push({ klasse: klasse.name, jahrgang, lehrer: auszuwählen, klassenleiter, raum });
      auszuwählen.forEach(l => besetzt.add(l));
      zuweisungen.set(klasse.name, auszuwählen);
      slotGefunden = true;
      break;
    }

    if (!slotGefunden) {
      warnungen.push(`Für Klasse ${klasse.name} konnte kein passender Slot gefunden werden${klassenleiterPflicht && klassenleiter ? ` (Klassenleiter ${klassenleiter} anderweitig verplant)` : ''}.`);
    } else if (einerProJahrgang && !jahrgang) {
      warnungen.push(`Klasse ${klasse.name} hat keinen Jahrgang zugewiesen (wird ohne Jahrgangsbeschränkung verplant).`);
    }
  });

  for (let slot = 0; slot < maxSlots; slot++) {
    const besetzt = belegung[slot];
    const slotKlassen = plan[slot];
    if (slotKlassen.length === 0) continue;

    const verfügbareLehrer = Array.from(state.anwesendeLehrer).filter(l => !besetzt.has(l));
    const klassenMitQuote = slotKlassen.map(entry => {
      const klasse = state.klassenMap[entry.klasse];
      const gesamtLehrer = klasse.lehrerSet.size;
      return { entry, aktuelleQuote: entry.lehrer.length / gesamtLehrer, gesamtLehrer };
    }).sort((a, b) => a.aktuelleQuote - b.aktuelleQuote);

    for (const lehrer of verfügbareLehrer) {
      for (const { entry, gesamtLehrer } of klassenMitQuote) {
        const klasse = state.klassenMap[entry.klasse];
        if (klasse.lehrerSet.has(lehrer) && entry.lehrer.length < gesamtLehrer && !(klassenleiterPflicht && lehrer === klasse.kl && entry.lehrer.includes(lehrer))) {
          entry.lehrer.push(lehrer);
          besetzt.add(lehrer);
          klassenMitQuote.find(k => k.entry === entry).aktuelleQuote = entry.lehrer.length / gesamtLehrer;
          klassenMitQuote.sort((a, b) => a.aktuelleQuote - b.aktuelleQuote);
          break;
        }
      }
    }
  }

  return { plan, warnungen };
}

function zeigeErgebnis(ergebnis) {
  const { plan, warnungen } = ergebnis;
  const maxSlots = parseInt(document.getElementById('maxSlots')?.value) || 0;
  const anwesendQuote = parseFloat(document.getElementById('anwesendQuote')?.value) || 0;
  const klassenleiterPflicht = document.getElementById('klassenleiterPflicht')?.checked;

  let ausgabe = '';
  const doppelteLehrerWarnungen = [];
  const quoteWarnungen = [];
  const klassenleiterWarnungen = [];
  const doppelteLehrer = new Map();
  const raumDuplikate = new Map(); // Neu: Map für Raum-Duplikate pro Slot

  let konferenzAnzahl = 0, summeQuote = 0, maxQuote = -Infinity, minQuote = Infinity;
  let maxQuoteKlasse = '', minQuoteKlasse = '';

  // Überprüfe Raum-Duplikate pro Slot
  plan.forEach((slotDaten, slotIndex) => {
    const raumVerwendung = new Map();
    slotDaten.forEach(e => {
      const raum = e.raum || '';
      if (raum) {
        raumVerwendung.set(raum, (raumVerwendung.get(raum) || 0) + 1);
      }
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
      const aktuelleQuote = e.lehrer.length / gesamtLehrer;

      konferenzAnzahl++;
      summeQuote += aktuelleQuote;
      if (aktuelleQuote > maxQuote) { maxQuote = aktuelleQuote; maxQuoteKlasse = e.klasse; }
      if (aktuelleQuote < minQuote) { minQuote = aktuelleQuote; minQuoteKlasse = e.klasse; }

      if (aktuelleQuote < anwesendQuote) {
        quoteWarnungen.push(`Klasse ${e.klasse} in Slot ${slotIndex + 1} hat eine Anwesenheitsquote von ${aktuelleQuote.toFixed(2)} (unter der Mindestanwesenheitsquote von ${anwesendQuote}).`);
      }
      if (klassenleiterPflicht) {
        if (!klasse.kl) {
          klassenleiterWarnungen.push(`Klasse ${e.klasse} hat keinen Klassenleiter zugeordnet in Slot ${slotIndex + 1} (Klassenleiterpflicht aktiviert, Klasse wurde trotzdem verplant).`);
        } else if (klasse.kl && !e.lehrer.includes(klasse.kl)) {
          klassenleiterWarnungen.push(`Klassenleiter ${klasse.kl} der Klasse ${e.klasse} ist in Slot ${slotIndex + 1} nicht anwesend (Klasse wurde trotzdem verplant).`);
        }
      }
    });
  });

  const durchschnittQuote = konferenzAnzahl > 0 ? summeQuote / konferenzAnzahl : 0;
  const statistikAusgabe = `
    <p><strong>Anzahl der Konferenzen:</strong> ${konferenzAnzahl}</p>
    <p><strong>Durchschnittliche Anwesenheitsquote:</strong> ${(durchschnittQuote * 100).toFixed(2)} %</p>
    <p><strong>Maximale Anwesenheitsquote:</strong> ${(maxQuote * 100).toFixed(2)} % (Klasse ${maxQuoteKlasse})</p>
    <p><strong>Minimale Anwesenheitsquote:</strong> ${(minQuote * 100).toFixed(2)} % (Klasse ${minQuoteKlasse})</p>
  `;

  // Kombiniere alle Warnungen in einer einzigen Liste
  const alleWarnungen = [...warnungen, ...doppelteLehrerWarnungen, ...quoteWarnungen, ...klassenleiterWarnungen];

  // Erstelle einen einzigen Abschnitt für alle Warnungen
  ausgabe = plan.every(slot => slot.length === 0)
    ? `<div class="warnungen"><strong>Fehler:</strong><p>Keine Klassen konnten verplant werden. Bitte überprüfen Sie die Einstellungen.</p></div>`
    : alleWarnungen.length > 0
      ? `<div class="warnungen"><strong>Warnungen:</strong><ul>${alleWarnungen.map(w => `<li>${w}</li>`).join('')}</ul></div><div class="info">${statistikAusgabe}</div>`
      : `<div class="info"><strong>Erfolg:</strong><p>Keine Warnungen! Alle Klassen wurden erfolgreich verplant.</p>${statistikAusgabe}</div>`;

  plan.forEach((slotDaten, slotIndex) => {
    ausgabe += `<h3>Slot ${slotIndex + 1} <span class="slot-controls print-hidden">`;
    if (slotIndex > 0) ausgabe += `<button class="move-slot-up" data-slot="${slotIndex}">↑ Nach oben</button> `;
    if (slotIndex < maxSlots - 1) ausgabe += `<button class="move-slot-down" data-slot="${slotIndex}">↓ Nach unten</button> `;
    ausgabe += `<select class="slot-mover print-hidden" data-current-slot="${slotIndex}"><option value="${slotIndex}">Bleibt in Slot ${slotIndex + 1}</option>`;
    for (let i = 0; i < maxSlots; i++) {
      if (i !== slotIndex) ausgabe += `<option value="${i}">In Slot ${i + 1} verschieben</option>`;
    }
    ausgabe += `</select></span></h3>`;
    ausgabe += '<table border="1" cellpadding="5" cellspacing="0"><thead><tr><th>Klasse</th><th>Raum</th><th>Anwesend</th><th>Möglich</th><th>Quote</th><th class="print-hidden">Slot</th></tr></thead><tbody>';

    slotDaten.forEach(e => {
      const kl = state.klassenMap[e.klasse];
      const alleLehrerDerKlasse = Array.from(kl.lehrerSet).filter(l => state.anwesendeLehrer.has(l));
      const anwesend = e.lehrer;
      const moeglich = alleLehrerDerKlasse.filter(l => !anwesend.includes(l));
      const gesamtLehrer = kl.lehrerSet.size;
      const anwesendQuote = anwesend.length / gesamtLehrer;

      const anwesendHTML = anwesend.map(l => {
        const isDoppelt = doppelteLehrer.has(slotIndex) && doppelteLehrer.get(slotIndex).has(l);
        const faecher = kl.lehrerFaecher.get(l) ? Array.from(kl.lehrerFaecher.get(l)).join(', ') : '';
        return `<li${isDoppelt ? ' class="doppelter-lehrer"' : ''}>${l}${faecher ? ` (${faecher})` : ''} <a href="#" class="move-teacher-right print-hidden" data-slot="${slotIndex}" data-klasse="${e.klasse}" data-lehrer="${l}">→</a></li>`;
      }).join('');

      const moeglichHTML = moeglich.length > 0
        ? `<ul>${moeglich.map(l => {
          const faecher = kl.lehrerFaecher.get(l) ? Array.from(kl.lehrerFaecher.get(l)).join(', ') : '';
          return `<li><a href="#" class="move-teacher-left print-hidden" data-slot="${slotIndex}" data-klasse="${e.klasse}" data-lehrer="${l}">←</a> ${l}${faecher ? ` (${faecher})` : ''}</li>`;
        }).join('')}</ul>`
        : '<em>Keine</em>';

      const dropdownHTML = `<select class="slot-changer print-hidden" data-klasse="${e.klasse}" data-current-slot="${slotIndex}">${Array.from({ length: maxSlots }, (_, i) => `<option value="${i}"${i === slotIndex ? ' selected' : ''}>Slot ${i + 1}</option>`).join('')}</select>`;

      // Raum-Dropdown: Optionen aus state.raeume
      const raumOptions = state.raeume.map((raum, index) => `<option value="${raum || ''}"${(e.raum || '') === (raum || '') ? ' selected' : ''}>${raum || `Raum ${index + 1}`}</option>`).join('');
      const raumDuplikat = raumDuplikate.get(slotIndex) && raumDuplikate.get(slotIndex).get(e.raum || '') > 1;
      const raumClass = raumDuplikat ? ' class="raum-duplikat"' : '';
      const raumHinweis = raumDuplikat ? ' <span class="raum-hinweis">(Mehrfachnutzung!)</span>' : '';

      ausgabe += `<tr><td>${e.klasse} (${e.klassenleiter || '<em>...</em>'})</td><td class="print-hidden"${raumClass}><select class="raum-select" data-slot="${slotIndex}" data-klasse="${e.klasse}">${raumOptions}</select>${raumHinweis}</td><td><ul>${anwesendHTML}</ul></td><td>${moeglichHTML}</td><td>${(anwesendQuote * 100).toFixed(0)} % von ${gesamtLehrer}</td><td class="print-hidden">${dropdownHTML}</td></tr>`;
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
  addSlotMoveListeners(plan, ergebnis); // Neue Funktion für Slot-Verschiebung
  addRaumSelectListeners(plan, ergebnis); // Modifizierte Funktion für Raum-Select
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

      const lehrerInNeuemSlot = new Set(plan[newSlot].flatMap(e => e.lehrer));
      const doppelteLehrer = klasseEntry.lehrer.filter(l => lehrerInNeuemSlot.has(l));
      if (doppelteLehrer.length > 0) {
        if (!confirm(`Warnung: Die folgenden Lehrer sind bereits in Zeitfenster ${newSlot + 1} anwesend: ${doppelteLehrer.join(', ')}. Möchten Sie die Klasse trotzdem verschieben?`)) {
          this.value = currentSlot;
          return;
        }
      }

      if (klassenleiterPflicht && klasseEntry.klassenleiter) {
        const lehrerInCurrentSlot = new Set(currentSlotData.filter(e => e.klasse !== klasse).flatMap(e => e.lehrer));
        if (!lehrerInCurrentSlot.has(klasseEntry.klassenleiter) && plan[newSlot].some(e => e.lehrer.includes(klasseEntry.klassenleiter))) {
          alert(`Klassenleiter ${klasseEntry.klassenleiter} ist in Zeitfenster ${newSlot + 1} bereits anwesend. Dies würde die Klassenleiterpflicht verletzen.`);
          this.value = currentSlot;
          return;
        }
      }

      // Raum mitnehmen (da editierbar, bleibt der aktuelle)
      // const raumIndex = plan[newSlot].length % state.raeume.length;
      // klasseEntry.raum = state.raeume[raumIndex] || `Raum ${raumIndex + 1}`;

      currentSlotData.splice(currentSlotData.indexOf(klasseEntry), 1);
      plan[newSlot].push(klasseEntry);
      state.aktuellerPlan.plan = plan;
      speicherePlan(); // Speichere Plan und anwesende Lehrer
      zeigeErgebnis(ergebnis);
    });
  });
}

// Modifizierte Funktion für Raum-Select
function addRaumSelectListeners(plan, ergebnis) {
  document.querySelectorAll('.raum-select').forEach(select => {
    select.addEventListener('change', function () {
      const slotIndex = parseInt(this.dataset.slot);
      const klasse = this.dataset.klasse;
      const newRaum = this.value.trim();

      const slotData = plan[slotIndex];
      const entry = slotData.find(e => e.klasse === klasse);
      if (entry) {
        entry.raum = newRaum || '';
        state.aktuellerPlan.plan = plan;
        speicherePlan();
        zeigeErgebnis(ergebnis); // Aktualisiere die Anzeige, um Duplikat-Warnungen zu überprüfen
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

      const lehrerInAnderenKlassen = new Set(
        currentSlot
          .filter(e => e.klasse !== klasse)
          .flatMap(e => e.lehrer)
      );
      const istDoppelt = lehrerInAnderenKlassen.has(lehrer);

      targetKlasse.lehrer.push(lehrer);

      speicherePlan(); // Speichere Plan und anwesende Lehrer
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

      const gesamtLehrer = state.klassenMap[klasse].lehrerSet.size;
      const mindAnwesend = Math.ceil(gesamtLehrer * anwesendQuote);

      if (klassenleiterPflicht && state.klassenMap[klasse].kl === lehrer) {
        alert(`Fehler: ${lehrer} ist der Klassenleiter von ${klasse}. Das Entfernen verletzt die Klassenleiterpflicht!`);
        return;
      }

      if (targetKlasse.lehrer.length - 1 < mindAnwesend) {
        alert(`Fehler: Das Entfernen von ${lehrer} würde die Mindestanwesenheitsquote von ${anwesendQuote} für ${klasse} verletzen!`);
        return;
      }

      targetKlasse.lehrer.splice(targetKlasse.lehrer.indexOf(lehrer), 1);
      speicherePlan(); // Speichere Plan und anwesende Lehrer
      zeigeErgebnis(ergebnis);
    });
  });
}

// Neue Funktion für das Verschieben ganzer Slots
function addSlotMoveListeners(plan, ergebnis) {
  // Nach oben/Nach unten Buttons
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

  // Slot-Mover Select
  document.querySelectorAll('.slot-mover').forEach(select => {
    select.addEventListener('change', (e) => {
      const currentSlot = parseInt(e.target.dataset.currentSlot);
      const newSlot = parseInt(e.target.value);
      if (currentSlot === newSlot) {
        e.target.value = currentSlot;
        return;
      }

      // Verschiebe den gesamten Slot-Inhalt
      const temp = plan[newSlot];
      plan[newSlot] = plan[currentSlot];
      plan[currentSlot] = temp;

      // Räume für neuen Slot mitnehmen (da editierbar, bleiben pro Entry)
      // plan[newSlot].forEach((entry, index) => {
      //   const raumIndex = index % state.raeume.length;
      //   entry.raum = state.raeume[raumIndex] || `Raum ${raumIndex + 1}`;
      // });

      state.aktuellerPlan.plan = plan;
      speicherePlan();
      zeigeErgebnis(ergebnis);
    });
  });
}

// Modifizierte Export-Funktionen mit Raum
function exportKlassenplan() {
  if (!state.aktuellerPlan) {
    alert('Kein Plan zum Exportieren verfügbar. Bitte erstellen Sie zuerst einen Plan.');
    return;
  }

  let csvContent = '\uFEFFSlot;Klasse;Raum;Klassenleiter;Lehrkräfte\n';
  state.aktuellerPlan.plan.forEach((slot, slotIndex) => {
    slot.forEach(entry => {
      csvContent += `"Slot ${slotIndex + 1}";"${entry.klasse}";"${entry.raum || ''}";"${entry.klassenleiter || ''}";"${entry.lehrer.join(', ')}"\n`;
    });
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'klassenkonferenz_plan.csv';
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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

  let csvContent = '\uFEFFLehrer;' + Array.from({ length: maxSlots }, (_, i) => `Slot ${i + 1}`).join(';') + '\n';
  lehrerPlan.forEach((slots, lehrer) => {
    csvContent += `"${lehrer}";${slots.map(slot => `"${slot}"`).join(';')}\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'lehrer_konferenz_plan.csv';
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Planungsoptionen (erweitert um Räume)
function speicherePlanungsoptionen() {
  const optionen = {
    maxSlots: document.getElementById('maxSlots')?.value,
    maxKlassenProSlot: document.getElementById('maxKlassenProSlot')?.value,
    anwesendQuote: document.getElementById('anwesendQuote')?.value,
    klassenleiterPflicht: document.getElementById('klassenleiterPflicht')?.checked,
    einerProJahrgang: document.getElementById('einerProJahrgang')?.checked,
    bevorzugteFaecher: Array.from(state.bevorzugteFaecher),
    raeume: state.raeume,
  };
  saveToLocalStorage('planungsoptionen', JSON.stringify(optionen));
}

function ladePlanungsoptionen() {
  const gespeicherteOptionen = getFromLocalStorage('planungsoptionen');
  if (gespeicherteOptionen) {
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
    state.bevorzugteFaecher = new Set(optionen.bevorzugteFaecher || []);
    state.raeume = optionen.raeume || [];
    // Aktualisiere Räume-UI nach dem Laden
    updateRaeumeUI();
  }
}

function updateFaecherUI() {
  const fCont = document.getElementById('faecherContainer');
  if (fCont) {
    fCont.innerHTML = Array.from(state.faecherSet).sort().map(f => `
      <label><input type="checkbox" class="fachCheckbox" value="${f}" ${state.bevorzugteFaecher.has(f) ? 'checked' : ''}> ${f}</label>
    `).join('');
  }
}

// Neue Funktion: Alle Klassen auswählen
function selectAllKlassen() {
  document.querySelectorAll('.klasseCheckbox').forEach(cb => {
    if (state.klassenMap[cb.value]) cb.checked = true;
  });
  speichereAuswahl();
  addStatusMessage('Alle Klassen ausgewählt.');
}

// Neue Funktion: Alle Lehrer auswählen
function selectAllLehrer() {
  document.querySelectorAll('.lehrerCheckbox').forEach(cb => {
    if (state.lehrerSet.has(cb.value)) cb.checked = true;
  });
  speichereAuswahl();
  addStatusMessage('Alle Lehrer ausgewählt.');
}

// Event-Listener
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOMContentLoaded ausgelöst');

  
  const details = document.querySelectorAll('.faq-item');

  details.forEach((detail) => {
    detail.addEventListener('toggle', () => {
      if (detail.open) {
        // Schließe alle anderen offenen Details
        details.forEach((otherDetail) => {
          if (otherDetail !== detail && otherDetail.open) {
            otherDetail.open = false;
          }
        });
      }
    });
  });

  console.log('Lade gespeicherte Daten...');
  await ladeGespeicherteCSV(); // Kein changedFile, da Initialisierung
  console.log('Lade Planungsoptionen...');
  ladePlanungsoptionen();
  console.log('Zeige CSV-Bearbeitung...');
  await zeigeCSVBearbeitung();
  console.log('Aktualisiere UI...');
  updateUI();

  // Zeige gespeicherten Plan, falls vorhanden
  if (state.aktuellerPlan) {
    console.log('Zeige gespeicherten Plan...');
    activateTab('planung'); // Aktiviere den Planungstab
    zeigeErgebnis(state.aktuellerPlan);
  }

  const loadingIndicator = document.getElementById('loadingIndicator');
  if (loadingIndicator) {
    console.log('loadingIndicator gesehen');
    loadingIndicator.classList.add('active');
  } else {
    console.error('loadingIndicator nicht gefunden');
  }

  console.log('Lade gespeicherte Daten...');
  await ladeGespeicherteCSV(); // Kein changedFile, da Initialisierung
  console.log('Lade Planungsoptionen...');
  ladePlanungsoptionen();
  console.log('Zeige CSV-Bearbeitung...');
  await zeigeCSVBearbeitung();
  console.log('Aktualisiere UI...');
  updateUI();

  const storedMessages = getFromLocalStorage('csvMessages');
  const csvMessageDiv = document.getElementById('csvMessage');
  if (storedMessages && csvMessageDiv) {
    const messages = JSON.parse(storedMessages);
    csvMessageDiv.innerHTML = messages
      .map(msg => `<p class="${msg.isWarning ? 'warning' : msg.isError ? 'error' : 'success'}">${msg.text}</p>`)
      .join('');
    // Entferne Scrollen, da flex-direction: column-reverse verwendet wird
    // csvMessageDiv.scrollTop = csvMessageDiv.scrollHeight;
  }

  if (loadingIndicator) {
    console.log('Entferne loadingIndicator active-Klasse');
    loadingIndicator.classList.remove('active');
  }


  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('jahrgangInput')) {
      speichereAuswahl();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('klasseCheckbox') || e.target.classList.contains('lehrerCheckbox')) {
      speichereAuswahl();
    }
  });

  document.addEventListener('change', (e) => {
    if (
      e.target.classList.contains('klasseCheckbox') ||
      e.target.classList.contains('lehrerCheckbox') ||
      e.target.classList.contains('jahrgangInput')
    ) {
      speichereAuswahl();
    }
  });

  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', async () => {
      const tab = button.getAttribute('data-tab');
      console.log(`Tab-Wechsel zu: ${tab}`);
      activateTab(tab);
      toggleJahrgangInputs();
    });
  });

  console.log('Event-Listener für Tab-Buttons hinzugefügt');

  const unterrichtInput = document.getElementById('unterrichtInput');
  if (unterrichtInput) {
    console.log('unterrichtInput gefunden');
    unterrichtInput.addEventListener('change', async (e) => {
      console.log('unterrichtInput change-Event ausgelöst');
      const file = e.target.files[0];
      if (!file) {
        console.log('Keine Datei ausgewählt');
        addStatusMessage('Keine Unterrichts-Datei ausgewählt.', true);
        return;
      }

      if (loadingIndicator) loadingIndicator.classList.add('active');

      const reader = new FileReader();
      reader.onload = async (ev) => {
        console.log('Unterrichts geladen:', ev.target.result);
        saveToLocalStorage('unterrichtCSV', ev.target.result.trim());
        state.unterrichtLoaded = true;
        await ladeGespeicherteCSV('unterricht'); // Übergib 'unterricht' als changedFile
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
    console.log('klassenleiterInput gefunden');
    klassenleiterInput.addEventListener('change', async (e) => {
      console.log('klassenleiterInput change-Event ausgelöst');
      const file = e.target.files[0];
      if (!file) {
        console.log('Keine Datei ausgewählt');
        addStatusMessage('Keine Klassenleiter-Datei ausgewählt.', true);
        return;
      }

      if (loadingIndicator) loadingIndicator.classList.add('active');

      const reader = new FileReader();
      reader.onload = async (ev) => {
        console.log('Klassenleiter geladen:', ev.target.result);
        saveToLocalStorage('klassenleiterCSV', ev.target.result.trim());
        state.klassenleiterLoaded = true;
        await ladeGespeicherteCSV('klassenleiter'); // Übergib 'klassenleiter' als changedFile
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

  const resetCSV = document.getElementById('resetCSV');
  if (resetCSV) {
    resetCSV.addEventListener('click', () => {
      localStorage.removeItem('unterrichtCSV');
      localStorage.removeItem('klassenleiterCSV');
      localStorage.removeItem('planDaten');
      localStorage.removeItem('auswahlDaten');
      localStorage.removeItem('csvMessages'); // Entferne Log-Meldungen
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
      if (csvMessageDiv) csvMessageDiv.innerHTML = ''; // Leere das Message-Div
      addStatusMessage('Alle Daten wurden zurückgesetzt.');
    });
  } else {
    console.error("Element mit ID 'resetCSV' wurde nicht gefunden.");
  }
  const addUnterrichtRow = document.getElementById('addUnterrichtRow');
  if (addUnterrichtRow) {
    addUnterrichtRow.addEventListener('click', () => {
      const unterrichtCSV = getFromLocalStorage('unterrichtCSV');
      const lines = unterrichtCSV ? unterrichtCSV.split('\n').filter(line => line.trim()) : [];
      // Für neue Zeilen: Annahme, dass Fachgruppe optional ist; hier ohne, um Kompatibilität zu wahren
      addTableRow('unterrichtCSVBody', ['klasse', 'fach', 'lehrkraft'], lines.length);
    });
  }

  const saveUnterrichtCSV = document.getElementById('saveUnterrichtCSV');
  if (saveUnterrichtCSV) {
    saveUnterrichtCSV.addEventListener('click', () => {
      // Bestimme fields basierend auf aktueller Tabelle
      const unterrichtBody = document.getElementById('unterrichtCSVBody');
      const firstRow = unterrichtBody?.querySelector('tr');
      if (firstRow) {
        const fields = Array.from(firstRow.querySelectorAll('input[data-field]')).map(input => input.dataset.field);
        saveCSV('unterrichtCSVBody', 'unterrichtCSV', fields, 'Unterricht wurde gespeichert.');
      } else {
        saveCSV('unterrichtCSVBody', 'unterrichtCSV', ['klasse', 'fach', 'lehrkraft'], 'Unterricht wurde gespeichert.');
      }
    });
  }


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
  const einerProJahrgang = document.getElementById('einerProJahrgang');
  if (einerProJahrgang) {
    einerProJahrgang.addEventListener('change', toggleJahrgangInputs);
  } else {
    console.error("Element mit ID 'einerProJahrgang' wurde nicht gefunden.");
  }

  // Event-Listener für maxKlassenProSlot zur Aktualisierung der Räume
  const maxKlassenProSlotInput = document.getElementById('maxKlassenProSlot');
  if (maxKlassenProSlotInput) {
    maxKlassenProSlotInput.addEventListener('input', () => {
      updateRaeumeUI();
      speicherePlanungsoptionen();
    });
  }

  // Neue Event-Listener für "Alle auswählen"-Buttons
  const selectAllKlassenBtn = document.getElementById('selectAllKlassen');
  if (selectAllKlassenBtn) {
    selectAllKlassenBtn.addEventListener('click', selectAllKlassen);
  }

  const selectAllLehrerBtn = document.getElementById('selectAllLehrer');
  if (selectAllLehrerBtn) {
    selectAllLehrerBtn.addEventListener('click', selectAllLehrer);
  }

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

      if (selectedKlassen.length === 0 || state.anwesendeLehrer.size === 0) {
        alert('Bitte Klassen und Lehrer auswählen.');
        return;
      }

      if (maxKlassenProSlot < 1) {
        alert('Die maximale Anzahl an Klassen pro Zeitfenster muss mindestens 1 sein.');
        return;
      }

      const minSlotsBenötigt = Math.ceil(selectedKlassen.length / maxKlassenProSlot);
      if (maxSlots < minSlotsBenötigt) {
        alert(`Mit ${maxKlassenProSlot} Klassen pro Zeitfenster benötigen Sie mindestens ${minSlotsBenötigt} Zeitfenster für ${selectedKlassen.length} Klassen. Bitte erhöhen Sie die Anzahl der Zeitfenster oder reduzieren Sie die Anzahl der Klassen.`);
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

      let maxVersuche = Number(document.getElementById('maxVersucheSlider').value);

      let versuchNr = 0, besteErgebnis = null, wenigstenWarnungen = Infinity, besteQuoteVarianz = Infinity;

      function naechsterVersuch() {
        versuchNr++;
        const ergebnis = versuchePlanung(maxSlots, maxKlassenProSlot, anwesendQuote, klassenleiterPflicht, einerProJahrgang, selectedKlassen);
        const quoten = ergebnis.plan.flat().map(entry => entry.lehrer.length / state.klassenMap[entry.klasse].lehrerSet.size);
        const durchschnitt = quoten.length > 0 ? quoten.reduce((sum, q) => sum + q, 0) / quoten.length : 0;
        const varianz = quoten.length > 0 ? quoten.reduce((sum, q) => sum + Math.pow(q - durchschnitt, 2), 0) / quoten.length : Infinity;

        if (ergebnis.warnungen.length < wenigstenWarnungen || (ergebnis.warnungen.length === wenigstenWarnungen && varianz < besteQuoteVarianz)) {
          wenigstenWarnungen = ergebnis.warnungen.length;
          besteQuoteVarianz = varianz;
          besteErgebnis = ergebnis;
        }

        if (statusDiv) {
          statusDiv.innerHTML = `<p><strong>Versuch ${versuchNr}/${maxVersuche} - Beste Lösung bisher: ${wenigstenWarnungen} Warnungen, Varianz: ${isFinite(besteQuoteVarianz) ? besteQuoteVarianz.toFixed(4) : 'Keine Klassen verplant'}</strong></p>`;
        }

        if (versuchNr < maxVersuche) {
          setTimeout(naechsterVersuch, 1);
        } else {
          if (statusDiv) {
            statusDiv.innerHTML = `<p><strong>${maxVersuche} Versuche abgeschlossen. Beste gefundene Lösung mit ${wenigstenWarnungen} Warnungen und Varianz ${isFinite(besteQuoteVarianz) ? besteQuoteVarianz.toFixed(4) : 'Keine Klassen verplant'} wird angezeigt.</strong></p>`;
          }
          state.aktuellerPlan = besteErgebnis;
          speicherePlan(); // Speichere Plan und anwesende Lehrer
          zeigeErgebnis(besteErgebnis);
        }
      }

      naechsterVersuch();
    });
  } else {
    console.error("Element mit ID 'planBtn' wurde nicht gefunden.");
  }

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportKlassenplan);
  } else {
    console.error("Element mit ID 'exportBtn' wurde nicht gefunden.");
  }

  const exportLehrerBtn = document.getElementById('exportLehrerBtn');
  if (exportLehrerBtn) {
    exportLehrerBtn.addEventListener('click', exportLehrerplan);
  } else {
    console.error("Element mit ID 'exportLehrerBtn' wurde nicht gefunden.");
  }

  // Event-Listener für Fächer-Checkboxen
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('fachCheckbox')) {
      if (e.target.checked) {
        state.bevorzugteFaecher.add(e.target.value);
      } else {
        state.bevorzugteFaecher.delete(e.target.value);
      }
      speicherePlanungsoptionen();
    }
  });
});