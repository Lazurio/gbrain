# gbrain pro Lazurio: jak fork držíme a vydáváme

`Lazurio/gbrain` je fork [`garrytan/gbrain`](https://github.com/garrytan/gbrain).
Lazurio z něj instaluje paměťový server do Osobního Prostředí. Fork drží
**přesné stabilní vydání upstreamu a nad ním overlay Lazuria**. Overlay je
v této složce `lazurio/` a v malé sadě oprav kódu gbrainu, kterou upstream
ještě nemá (tabulka níže). Každá oprava je jeden commit s vlastními testy
a s návrhem pro upstream, aby fork nikdy nebránil převzetí novějšího upstreamu.

## Co fork přidává

| Cesta | Proč |
| --- | --- |
| `lazurio/README.md` | Tento postup. |
| `lazurio/fork-check.sh` | Ověří, že commit je přesný upstream tag a k němu jen overlay, opravy ze seznamu a verze vydání. |
| `lazurio/package-diff.sh`, `lazurio/package-diff.test.sh` | Pravidlo kontroly forku pro `package.json` (smí se lišit jen řádek s verzí) a jeho test. |
| `lazurio/patches.list` | Seznam oprav kódu: předmět commitu a soubory, které smí měnit. |
| `lazurio/upstream-check.sh` | Přenese opravy na novější upstream tag a skončí chybou, když se nepřenesou čistě. |
| `lazurio/upgrade-test/` | Zkouška přechodu mozku ze starého vydání na nové, na smyšlených datech. |

### Opravy kódu

| Oprava (předmět commitu) | Proč | Upstream |
| --- | --- | --- |
| `embed --stale: hand the drain to a resident PGLite owner (writer_embed_stale)` | Lazurio dopočítává hledání podle významu, zatímco server běží. Bez opravy `embed --stale` při běžícím serveru skončí `pglite_busy`, a paměť se musí zastavit. Server spouští běh stejně jako CLI: se souhlasem a stropem útraty, s průchodem obrázků a s rozpočtem času z CLI. | návrh PR připravený, odeslání čeká na slovo |
| `embeddings enable: record the model and width in the database plane too` | Mozek založený bez embeddingů a zapnutý později odmítal počítat vektory faktů (v databázi zůstal výchozí model). | návrh issue připravený, odeslání čeká na slovo |
| `embeddings enable: a brain whose vectors are all stamped with the model passes the identity check` | Mozek zapnutý dřívějším vydáním už má vektory stránek, ale v databázi výchozí model, takže opakované `enable` se stejným modelem končilo `embedding_model_mismatch` a fakta se nikdy nedopočítala. Rozhoduje teď označení modelu u každého vektoru; jiný nebo smíšený model se dál odmítne. | patří k návrhu issue výše |

Opravu zapisuj sem i do `lazurio/patches.list`, i s důvodem a s odkazem na
upstream issue nebo PR. Když upstream stejnou věc opraví, oprava z overlaye
odejde v další synchronizaci: smaž její řádek a commit už se nepřenese. Tak
skončil i první commit forku (stdout pod MCP stdio, #1): upstream ho opravil
sám.

## Opravy a novější upstream

Opravy nesmí bránit převzetí novějšího upstreamu. Platí proto:

1. **Malé a oddělené.** Každá oprava je jeden commit nad upstreamem. Mění jen
   soubory, které má ve svém řádku `lazurio/patches.list`, a nese vlastní
   testy. Commit, který by měnil víc, `upstream-check.sh` odmítne.
2. **Kontrola přenosu.** Před každým vydáním a pokaždé, když upstream povýší
   nové stabilní vydání, spusť
   `lazurio/upstream-check.sh v<současná verze> v<nová verze> --test`. Ten
   v dočasném worktree nad novým tagem přenese opravy cherry-pickem v pořadí
   ze seznamu a spustí jejich testy. Musí skončit `ok`.
3. **Když se oprava nepřenese,** je to nález pro review, ne věc k tichému
   vyřešení. Buď ji uprav nad novým upstreamem (nový commit se stejným
   předmětem), nebo ověř, jestli ji upstream mezitím nahradil, a smaž ji.
4. **Přechod na novější upstream** je běžná synchronizace (oddíl Vydání):
   merge nového tagu do `master`. Opravy jsou commity v historii `master`,
   takže je merge přenese. Kontrola přenosu předem ukáže, jestli při tom
   vznikne konflikt.
5. **Verze vydání.** Vydání s opravami nese ve `package.json` verzi
   `<upstream verze>-lazurio.<N>`, aby Lazurio poznalo nový pin i na stejném
   upstreamu. Je to jediná povolená změna `package.json` a není součástí sady
   oprav, při každém vydání se zapíše znovu.

## Které vydání bereme

Bereme jen vydání, které upstream povýšil do stabilního kanálu, tedy tag
`v<verze>` se stejnojmenným tagem `stable-v<verze>` na stejném commitu
(`docs/STABILITY.md` upstreamu). Alfa vydání (GitHub pre-release) nebereme.
Nemusí to být nejnovější stabilní vydání: přednost má to, které prošlo
zkouškou přechodu.

## Vydání

1. **Větev.** Z `master` založ `lazurio/sync-v<verze>` a slouč do ní upstream
   tag merge commitem (`git merge --no-ff v<verze>`). Overlay zůstává jen
   v `lazurio/`, takže by merge neměl mít konflikty. Pokud je má, je to nález
   pro review, ne věc k tichému vyřešení.
2. **Kontrola forku.** `lazurio/fork-check.sh v<verze>` musí skončit `ok`.
   Když fork nese opravy kódu, musí projít i
   `lazurio/upstream-check.sh v<verze> v<nejnovější stabilní verze> --test`.
3. **Zkouška přechodu.** Do prázdné složky mimo repozitář spusť
   `lazurio/upgrade-test/run.sh <složka> github:Lazurio/gbrain#<předchozí tag> github:Lazurio/gbrain#lazurio/sync-v<verze>`.
   Skript postaví mozek na předchozím vydání tak, jak ho zakládá Lazurio
   (PGLite bez embeddingů, vault jako git checkout s pushem, klíče z admin
   API), naplní ho smyšlenými stránkami, odkazy a fakty a převede ho. Musí
   skončit `PASS`. Zkouška hlídá počty a ID, `recall`, `remember`, klíče a jejich
   scopy, rozhraní nástrojů MCP (žádný nástroj ani parametr nesmí zmizet nebo
   se zpřísnit), to, že přechod nesáhne na soubory vaultu, push po zápisu,
   start starého vydání nad migrovanou databází a obnovu ze zálohy.
4. **Pull request** do `master` popiš výstupy obou kontrol, verzí schématu
   databáze před přechodem a po něm a riziky. Review a merge řídí pravidla
   Organizace LazurioDevelopment (review `agentrozjedemeai`). Merge je jen
   merge commit, nikdy squash ani rebase: historie upstreamu musí zůstat
   předkem `master`.
5. **Tag.** Po merge vytvoř na merge commitu v `master` anotovaný tag
   `v<verze>-lazurio.<N>`. N začíná na 1 a roste, když se na stejném upstream
   vydání změní overlay. `lazurio/fork-check.sh v<verze> v<verze>-lazurio.<N>`
   musí projít i na tagu. Tag je neměnný: existující tagy se nepřesouvají ani
   nemažou a do `master` se nic nepushuje silou.
6. **Pin.** Lazurio připíná vydání přesným tagem, commitem a verzí. Změna pinu
   jde vlastním pull requestem a nasazuje se po ringech, nejdřív na zkušební
   Organizaci. Před přechodem každého Prostředí se zálohuje `~/.gbrain`
   a checkout vaultu.

GitHub Actions jsou ve forku vypnuté, aby v něm neběžely workflow upstreamu.
Kontroly proto spouští ten, kdo vydání připravuje, a jejich výstup patří do
pull requestu. Workflow `.github/workflows/lazurio-upstream-check.yml` je
připravený pro den, kdy se Actions ve forku zapnou jen pro workflow Lazuria.
Pak kontrolu přenosu spustí každý den a u každého pull requestu sám.

## Cesta zpět

Migrace schématu jsou jen dopředné. Starší gbrain nad novějším schématem podle
upstreamu dál čte a běží, jen odmítne schéma znovu zakládat (`client_behind`).
Zkouška přechodu to u každého vydání ověřuje, ale spoléhat se na to nedá.
Pojistkou je záloha `~/.gbrain` a vaultu pořízená před přechodem: zastavit
server, vrátit zálohu, nainstalovat předchozí tag a server spustit.
