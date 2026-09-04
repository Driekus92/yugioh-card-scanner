# Yu-Gi-Oh! kaartscanner

Deze web-app maakt per scan één foto, leest daarop de kaartnaam en set-code, controleert de kaart via de YGOPRODeck API en bewaart de scanlijst lokaal in de browser. De lijst kan als echt Excel-bestand (`.xlsx`) worden geëxporteerd met de kolommen `Kaartnaam`, `Set-code` en `Waarde`.

## Starten

Een camera werkt in een browser alleen via HTTPS of via `localhost`. Start daarom in deze map een eenvoudige lokale webserver en open daarna het getoonde localhost-adres in de browser. Rechtstreeks dubbelklikken op `index.html` is niet voldoende voor cameratoegang.

Voor gebruik op een telefoon kan de site via HTTPS worden gepubliceerd en vervolgens als web-app op het beginscherm worden gezet. Als cameratoegang niet beschikbaar is, blijft **Foto maken of kiezen** beschikbaar.

## Scanvolgorde

1. Open de scanner en leg de volledige kaart binnen het kader.
2. Tik op **Foto maken en scannen**. Alleen die stilstaande foto wordt verwerkt.
3. De app leest eerst de kaartnaam en zoekt mogelijke kaarten op in YGOPRODeck.
4. Wanneer de naam meerdere mogelijkheden of meerdere kaartdrukken oplevert, leest de app daarna de set-code met meerdere OCR-zones en vergelijkt die eerst met de bekende set-codes van de gevonden kaarten.
5. Als de set-code niet betrouwbaar genoeg is, kan hij handmatig worden ingevuld.
6. Exporteer de lijst vanaf het beginscherm naar Excel. `Waarde` blijft leeg voor latere aanvulling. Exporteren wist de scanlijst niet; wissen gebeurt alleen via **Lijst wissen**.

De scanlijst wordt blijvend opgeslagen in de browser met een combinatie van `localStorage` en IndexedDB. Daardoor blijft de lijst ook na sluiten/herstarten van de app staan en wordt een lokale backup gebruikt wanneer de primaire opslag niet beschikbaar is. Het wissen van browsergegevens verwijdert ook de opgeslagen scans.
