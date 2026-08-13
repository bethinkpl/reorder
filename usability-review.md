# Przegląd Użyteczności: Plugin Loyalty MedusaJS dla Wymagań Kart Podarunkowych

**Wersja dokumentu:** 1.0  
**Data przeglądu:** 2026-07-16  
**Wersja pluginu:** MedusaJS v2+ (commit `c3713be51df64cec0f454ba6a598c801a979d243`)

---

## Podsumowanie Wykonawcze

| Metryka | Wynik |
|---------|-------|
| **Spełnione wymagania** | 1 / 11 (9%) |
| **Częściowo spełnione** | 5 / 11 (45%) |
| **Niespełnione** | 5 / 11 (45%) |
| **Ogólna ocena** | ❌ **NIEODPOWIEDNI** |
| **Problemy blokujące** | 2 krytyczne konflikty architektoniczne |

### Rekomendacja

Plugin nie nadaje się do realizacji wymagań ze względu na **fundamentalny konflikt architektoniczny** — mechanizm konsolidacji sald do wspólnego konta **store credit** uniemożliwia:
- Śledzenie atomowe poszczególnych kart podarunkowych
- Wymuszanie indywidualnych dat wygaśnięcia po przypisaniu
- Implementację logiki FIFO opartej na dacie przypisania karty

---

## Szczegółowa Analiza Wymagań

### ✗ Wymaganie 1: Rozróżnienie Giftcardów z Indywidualnymi Datami Wygaśnięcia

> **Wymaganie:** Musi dać się rozróżnić giftcardy przypisane do konta, bo musimy wiedzieć kiedy dostępne środki mają wygasać - nie możemy mieć jednej daty na całe konto

| Aspekt | Ocena |
|--------|-------|
| **Status** | ❌ **NIEOBSŁUGIWANE** |
| **Dotkliwość** | 🔴 **BLOKER** |

#### Architektura pluginu

Po **claiming** (przypisaniu karty do klienta), salda są **konsolidowane** w jedno konto:

```typescript
// claimStoreCreditAccountWorkflow
// Sprawdza czy klient ma już konto store credit w tej walucie
const existingAccount = useQueryGraphStep({
  filters: {
    customer_id: input.customer_id,
    currency_code: giftCard.currency_code
  }
});

// Transfer salda: debet z konta anonimowego, kredyt na konto klienta
debitAccountStep([{ account_id: anonymousAccount.id, amount: 50 }]);
creditAccountStep([{ account_id: customerAccount.id, amount: 50 }]);
```

#### Przykład problemu

```
Klient przypisuje trzy karty:
├─ GiftCard A: 50 PLN (wygasa 2026-12-31)
├─ GiftCard B: 30 PLN (wygasa 2027-06-30)
└─ GiftCard C: 20 PLN (wygasa 2027-12-31)

Wynik w pluginie:
└─ Konto store credit klienta: 100 PLN
   (saldo skonsolidowane, bez rozróżnienia źródeł)
```

#### Konsekwencje

- ❌ **Nie można** śledzić, która kwota pochodzi z której karty
- ❌ **Nie można** wygasić 50 PLN w dniu 2026-12-31 (część z GiftCard A)
- ❌ **Nie można** zastosować logiki FIFO (najpierw A, potem B, potem C)
- ❌ **Nie można** wyświetlić klientowi listy jego kart z osobnymi datami ważności

#### Mechanizm audytu

Plugin zapisuje w transakcjach referencje do źródłowych kart podarunkowych:

```typescript
// Każda transakcja kredytowa zawiera
{
  reference: "gift_card",
  reference_id: "<gift_card_id>"
}
```

**Jednak:**
- ✓ **Można** odpytać, które karty wpłynęły na saldo
- ✗ **Nie można** kontrolować, jak skonsolidowane saldo jest wydawane
- ✗ **Nie można** zapobiec wydawaniu środków z wygasłych części

#### Dlaczego to jest problem blokujący

Po połączeniu sald tracona jest atomowość pojedynczych kart. Saldo staje się **fungible** (zamienne) — nie ma możliwości wydzielenia "starych 50 PLN" od "nowych 30 PLN" w ramach jednego konta **store credit**.

---

### ✗ Wymaganie 2: Wykorzystanie FIFO (Od Najstarszych Giftcardów)

> **Wymaganie:** Wykorzystanie giftcardów: wybieramy od najstarszych giftcardów

| Aspekt | Ocena |
|--------|-------|
| **Status** | ❌ **NIEOBSŁUGIWANE** |
| **Dotkliwość** | 🔴 **BLOKER** |

#### Zachowanie pluginu

**Brak jakiejkolwiek logiki FIFO:**

```typescript
// confirmCartCreditLinesWorkflow
const debitAccountsInput = (cart.credit_lines || [])
  .map((cl) => ({
    account_id: cl.reference_id,
    amount: cl.amount,
    reference: "cart",
    reference_id: cart.id
  }));
```

Przetwarzanie:
- **Credit lines** są przetwarzane w kolejności iteracji (prawdopodobnie kolejność wstawienia do bazy)
- Brak sortowania po dacie przypisania, dacie wygaśnięcia lub jakimkolwiek kryterium
- Po **claiming**, wszystkie salda są **zamienne** — nie można odróżnić "starych pieniędzy" od "nowych"

#### Dlaczego FIFO jest niemożliwe

Po przypisaniu kart do klienta:
1. Salda łączą się w jedno konto **store credit**
2. Tożsamość poszczególnych kart jest tracona
3. Nie można określić, którą część wydać jako pierwszą
4. Nawet gdyby można było sortować **credit lines**, to one reprezentują już skonsolidowane saldo

---

### ⚠️ Wymaganie 3: Moduł Admina — Generowanie Giftcardów

> **Wymaganie:** Podajemy kwotę, walutę, datę ważności i ilość giftcardów do stworzenia

| Aspekt | Ocena |
|--------|-------|
| **Status** | ⚠️ **CZĘŚCIOWO OBSŁUGIWANE** |
| **Dotkliwość** | 🟡 **ŚREDNIA** |

#### Workflow pluginu

```typescript
// createGiftCardsWorkflow
Input: CreateGiftCardsWorkflowInput = ModuleCreateGiftCard[]

type ModuleCreateGiftCard = {
  code: string;                    // ✓ Auto-generowany jeśli pominięty
  value: number;                   // ✓ Kwota
  currency_code: string;           // ✓ Waluta (ISO kod, np. "pln")
  expires_at: string | null;       // ✓ Data ważności
  reference_id: string | null;
  reference: string | null;
  line_item_id: string;
  customer_id: string | null;
  metadata: Record<string, unknown>;
}
```

#### Co jest obsługiwane

- ✓ Kwota (`value`)
- ✓ Waluta (`currency_code`)
- ✓ Data ważności (`expires_at`)
- ✓ Tworzenie wielu kart naraz (input jest tablicą)

#### Czego brakuje

- ❌ **UI admina** — plugin nie dostarcza gotowego formularza do generowania kart
- ❌ **Batch creation endpoint** — dokumentacja nie precyzuje, czy standardowe API akceptuje tablicę
- ⚠️ **Generowanie kodów** — kody są auto-generowane, ale format może nie odpowiadać wymaganiom

#### Format generowanych kodów

```typescript
// Domyślny format
generateCode("GIFT", 4)
// Przykład: GIFT-A3H7-9KLP-2XM4-8NR6

// Konfigurowalne przez opcje pluginu
{ prefix: "GC", sections: 3 }
// Wynik: GC-A3H7-9KLP-2XM4
```

Cechy generatora:
- Używa `crypto.randomBytes()` (kryptograficznie bezpieczny)
- Wyklucza podobne znaki (0/O, 1/I)
- Konfigurowalne sekcje po 4 znaki

#### Dostępne trasy API

```
POST /admin/gift-cards      # Tworzenie kart
GET  /admin/gift-cards       # Listing
GET  /admin/gift-cards/:id   # Szczegóły pojedynczej karty
```

---

### ✗ Wymaganie 4: Eksport Giftcardów do CSV

> **Wymaganie:** Możliwość wyeksportować właśnie stworzonych giftcardów do CSV

| Aspekt | Ocena |
|--------|-------|
| **Status** | ❌ **NIEOBSŁUGIWANE** |
| **Dotkliwość** | 🟡 **ŚREDNIA** |

#### Stan pluginu

**Brak wbudowanej funkcjonalności eksportu.**

Plugin dostarcza jedynie:
- **Workflow** do tworzenia kart (`createGiftCardsWorkflow`)
- Trasy API do odczytu (`GET /admin/gift-cards`)

#### Co jest potrzebne

Eksport do CSV wymagałby:
- Implementacji niestandardowej trasy API
- Rozszerzenia UI admina o przycisk eksportu
- Logiki formatowania danych do CSV

---

### ✗ Wymaganie 5: System Statusów (+ Status "Przypisany")

> **Wymaganie:** Status giftcarda - analogiczne do statusów z kodów aktywacyjnych + status "przypisany"

| Aspekt | Ocena |
|--------|-------|
| **Status** | ❌ **NIEWYSTARCZAJĄCE** |
| **Dotkliwość** | 🟠 **DUŻA** |

#### Dostępne statusy w pluginie

```typescript
export enum GiftCardStatus {
  PENDING = "pending",      // Utworzona, ale nie aktywowana
  REDEEMED = "redeemed"    // Aktywowana (ma saldo)
}
```

#### Brakujące statusy

Analogicznie do kodów aktywacyjnych, brakuje:

- ❌ `ASSIGNED` / `"przypisany"` — oznaczenie kart przypisanych do klienta
- ❌ `ACTIVE` / `"aktywny"` — karta gotowa do użycia
- ❌ `DEACTIVATED` / `"dezaktywowany"` — dla kart anulowanych (np. fraudulent payment)
- ❌ `USED` / `"użyty"` — dla kart całkowicie wykorzystanych
- ❌ `EXPIRED` / `"wygasły"` — dla kart po dacie ważności

#### Śledzenie przypisania

Plugin używa **linków** zamiast statusu:

```typescript
// gift-card-store-credit link
defineLink(
  LoyaltyModule.linkable.giftCard,
  StoreCreditModule.linkable.storeCreditAccount
);
```

Możesz sprawdzić przypisanie przez:
```javascript
gift_card.store_credit_account?.customer_id !== null
```

**Ale:**
- Brak dedykowanego statusu `ASSIGNED`
- Trzeba wykonać join przez **store_credit_account**
- Nie jest to intuicyjne dla developerów

---

### ⚠️ Wymaganie 6: Listing Giftcardów z Filtrowaniem

> **Wymaganie:** Listing giftcardów wraz z filtrowaniem po kodzie, statusie i po użytkowniku do którego jest przypisany

| Aspekt | Ocena |
|--------|-------|
| **Status** | ⚠️ **CZĘŚCIOWO OBSŁUGIWANE** |
| **Dotkliwość** | 🟡 **ŚREDNIA** |

#### Dostępne API

```
GET /admin/gift-cards
```

#### Możliwości filtrowania

Standardowo dla modułów Medusa:

- ✓ Filtrowanie po `code` (pole **searchable**)
- ✓ Filtrowanie po `status` (pole **enum**)
- ⚠️ Filtrowanie po użytkowniku — wymaga użycia **query expansion**

#### Przykład filtrowania przez użytkownika

```typescript
// Zapytanie przez query API
const { data } = await query.graph({
  entity: "gift_card",
  fields: [
    "id",
    "code",
    "status",
    "value",
    "expires_at",
    "store_credit_account.customer_id",
    "store_credit_account.customer.email"
  ],
  filters: {
    code: { $ilike: "%GIFT%" },
    status: "redeemed",
    "store_credit_account.customer_id": "cust_123"
  }
});
```

#### Czego brakuje

- ❌ **Gotowy UI admina** z listingiem i filtrami
- ⚠️ **Dokumentacja** nie precyzuje, czy standardowa trasa REST obsługuje zagnieżdżone filtry
- ⚠️ Może wymagać implementacji custom query resolver

---

### ⚠️ Wymaganie 7: Możliwość Deaktywowania Giftcardów

> **Wymaganie:** Możliwość deaktywowania giftcards (np. fraudulent payment)

| Aspekt | Ocena |
|--------|-------|
| **Status** | ⚠️ **CZĘŚCIOWO OBSŁUGIWANE** |
| **Dotkliwość** | 🟠 **DUŻA** |

#### Dostępny mechanizm

```typescript
// deleteGiftCardWorkflow
Input: { id: string }

await module.deleteGiftCards([gift_card_id]);
// Z kompensacją: restoreGiftCards (soft delete?)
```

#### Problemy

**1. Usunięcie vs. dezaktywacja**

- **Delete** usuwa rekord (lub wykonuje soft delete)
- Wymagania sugerują **zmianę statusu** (jak w kodach aktywacyjnych: `active` → `deactivated`)
- Brak statusu `DEACTIVATED` w enum

**2. Problem po przypisaniu**

Jeśli karta została już **claimed**:
- Saldo jest w koncie **store credit** klienta
- Usunięcie **gift card** **NIE COFA** środków z konta klienta
- Klient nadal może wydać te środki
- Brak mechanizmu "wycofania" środków ze skonsolidowanego salda

#### Scenariusz fraudulent payment

```
1. Klient kupuje gift card za 100 PLN (fraudulent payment)
2. System tworzy gift card → status REDEEMED
3. Klient przypisuje kartę (claiming) → saldo 100 PLN w store credit
4. Wykrycie fraudu → próba deaktywacji:
   ✗ deleteGiftCard() usuwa rekord gift_card
   ✗ Ale saldo 100 PLN pozostaje w store credit account
   ✗ Klient może dalej wydać środki
```

#### Możliwe rozwiązania

**Rozszerzenie statusów:**
```typescript
export enum GiftCardStatus {
  PENDING = "pending",
  REDEEMED = "redeemed",
  DEACTIVATED = "deactivated",  // ← Nowy status
  EXPIRED = "expired"            // ← Nowy status
}
```

**Modyfikacja walidacji:**
```typescript
// W validateGiftCardStep
if (giftCard.status === "deactivated") {
  throw new MedusaError(
    MedusaError.Types.NOT_ALLOWED,
    "Gift card has been deactivated"
  );
}
```

**Ale:**
- ✗ Nie rozwiązuje problemu kart już przypisanych (saldo skonsolidowane)
- ✗ Wymagałaby również mechanizmu "cofnięcia" kredytu ze store credit account

---

### ✓ Wymaganie 8: Obniżenie Kwoty do Zapłaty (Nie Jako Zniżka)

> **Wymaganie:** Medusa musi obniżyć kwotę do zapłaty, najprawdopodobniej będziemy mieli osobne payment session w zamówieniu

| Aspekt | Ocena |
|--------|-------|
| **Status** | ✅ **W PEŁNI OBSŁUGIWANE** |
| **Dotkliwość** | N/A |

#### Mechanizm pluginu

Karty podarunkowe są modelowane jako **tax-neutral credit lines**, odejmowane **PO** obliczeniu podatku:

```typescript
// Silnik totalsów koszyka
const taxableBase = subtotal - adjustments  // Zniżki zmniejszają podstawę
const tax = taxableBase * taxRate
const creditLineTotal = sum(creditLines)
const total = taxableBase + tax - creditLineTotal  // Credit lines PO podatku
```

#### Zachowanie podatkowe

| Mechanizm | Zmniejsza podstawę opodatkowania? | Traktowanie podatkowe |
|-----------|----------------------------------|----------------------|
| **LineItemAdjustment** (zniżka) | ✓ TAK | Niesie podatek (`discount_tax_total`) |
| **CreditLine** (giftcard) | ✗ NIE | Neutralne podatkowo (`creditLinesSumTax = 0`) |

#### Dlaczego to jest poprawne

Karty podarunkowe jako środek płatniczy:
- ✓ Nie wpływają na obliczenie podatku
- ✓ Zmniejszają kwotę należną **po** opodatkowaniu
- ✓ Zgodne z większością jurysdykcji podatkowych

#### Osobne payment session?

Plugin **NIE tworzy** osobnej **payment session** dla kart podarunkowych.

**Mechanizm działania:**

1. **Credit lines** zmniejszają **payment collection amount**
2. Standardowa **payment session** (np. Stripe) jest tworzona dla **pozostałej kwoty**
3. Przy **checkout**, najpierw obciążane są **store credit accounts**, potem provider płatności

**Przykład:**

```
Zamówienie: 200 PLN (po podatku)
Gift card credit line: 50 PLN

Rezultat:
├─ Store credit account: -50 PLN (debet)
└─ Payment session (Stripe): 150 PLN (do zapłaty przez klienta)
```

#### Flow płatności

```
completeCartWorkflow
├─ beforePaymentAuthorization hook
│  └─ confirmCartCreditLinesWorkflow
│     └─ debitAccountsWorkflow (obciążenie store credit)
├─ authorizePaymentSessionStep
│  └─ Provider płatności (Stripe/PayPal/etc.)
│     Kwota = cart.total - creditLineTotal
└─ createOrdersStep
```

**To jest poprawna implementacja split payment.**

---

### ⚠️ Wymaganie 9: Przypisywanie Karty do Konta

> **Wymaganie:** Przypisywanie karty podarunkowej do konta

| Aspekt | Ocena |
|--------|-------|
| **Status** | ⚠️ **OBSŁUGIWANE, ALE INNA TERMINOLOGIA** |
| **Dotkliwość** | 🟡 **ŚREDNIA** (problem terminologiczny) |

#### Workflow pluginu

```typescript
// claimGiftCardWorkflow
Input: {
  code: "GIFT-A3H7-9KLP-2XM4",  // ← Klient wprowadza kod
  customer_id: "cust_123"
}

Kroki:
1. Wyszukanie gift card po kodzie
2. Walidacja, że klient ma zarejestrowane konto
3. Transfer salda z anonimowego konta store credit na konto klienta
4. Utworzenie linku gift_card ↔ customer (przez store_credit_account)
```

#### To jest mechanizm "przypisywania"

Po wykonaniu **claiming**:
- ✓ Karta jest powiązana z klientem
- ✓ Saldo jest na koncie klienta
- ✗ Ale: **saldo jest skonsolidowane** (tracona atomowość pojedynczych kart)

#### Dostępne API

```
POST /store/gift-cards/:code/claim
Body: { customer_id: "cust_123" }
```

Prawdopodobnie również:
```
POST /store/carts/:id/claim-gift-card
Body: { code: "GIFT-..." }
```

#### Uwaga terminologiczna

**Terminologia w pluginie:**

| Termin | Co oznacza |
|--------|------------|
| **Redeeming** | Aktywacja (utworzenie salda na anonimowym koncie) |
| **Claiming** | Przypisanie do klienta (transfer salda) |
| **Applying** | Dodanie do koszyka jako payment method |

**W potocznym użyciu:**
- "Redeem a gift card" = wykorzystać kartę do zapłaty
- Ale w pluginie "redeem" = aktywować

**Zalecenie:** Używać terminu **claiming** dla operacji przypisania.

---

### ⚠️ Wymaganie 10: Opcjonalne Wykorzystanie Kart (Decyzja Klienta)

> **Wymaganie:** Podczas składania zamówienia dodajemy możliwość decyzji czy wykorzystujemy saldo kart rabatowych czy nie

| Aspekt | Ocena |
|--------|-------|
| **Status** | ⚠️ **CZĘŚCIOWO OBSŁUGIWANE** |
| **Dotkliwość** | 🟡 **ŚREDNIA** |

#### Mechanizm pluginu

**Dla nieprzypisanych kart:**

```typescript
// addGiftCardToCartWorkflow
Input: {
  cart_id: "cart_123",
  code: "GIFT-XXXX-XXXX"  // ← Klient musi jawnie wprowadzić kod
}
```

✓ Karty są **opt-in** — klient musi jawnie zastosować je do koszyka

**Dla przypisanych kart (store credit):**

```typescript
// addStoreCreditsToCartWorkflow
Input: {
  cart_id: "cart_123",
  amount?: number  // Opcjonalnie: konkretna kwota lub całe saldo
}
```

#### Co to oznacza

**Opt-in model:**
- Klient musi **aktywnie** wywołać workflow dodania kredytu do koszyka
- Bez wywołania **addStoreCreditsToCartWorkflow** → brak **credit line** → normalna płatność
- Możliwość podania konkretnej kwoty (częściowe wykorzystanie salda)

**Jednak:**
- ❌ **Brak dokumentacji** o przepływie UI/UX
- ❌ **Brak dokumentacji** o opcji "nie używaj store credit" w standardowym checkout
- ⚠️ **Niejasne**, czy można całkowicie pominąć wykorzystanie przypisanego salda w UI

#### Możliwa implementacja

**Frontend może zaimplementować:**

```typescript
// Checkbox w checkout: "Użyj dostępnego salda kart podarunkowych"
async function handleCheckoutWithGiftCards(useGiftCards: boolean) {
  if (useGiftCards) {
    await addStoreCreditsToCartWorkflow.run({
      input: { cart_id: cartId }
      // Brak 'amount' = użyj całego dostępnego salda
    });
  }

  // Kontynuuj standardowy checkout
  await completeCartWorkflow.run({ input: { id: cartId } });
}
```

---

### ❓ Wymaganie 11: Automatyczne Wykorzystanie dla Subskrypcji

> **Wymaganie:** Dla subskrypcji zawsze pobieramy karty podarunkowe przypisane do kont

| Aspekt | Ocena |
|--------|-------|
| **Status** | ❓ **BRAK DOKUMENTACJI** |
| **Dotkliwość** | 🟡 **ŚREDNIA** |

#### Stan pluginu

Plugin **loyalty** NIE dostarcza specjalnej obsługi dla subskrypcji/płatności cyklicznych.

**Dokumentacja nie zawiera:**
- Mechanizmów automatycznego stosowania **store credit** do zamówień cyklicznych
- Hooków integrujących się z systemem subskrypcji
- Logiki priorytetyzacji kart podarunkowych przed innymi metodami płatności

#### Wymagana implementacja

W Waszym własnym pluginie subskrypcji musielibyście:

1. Przed utworzeniem zamówienia cyklicznego sprawdzić saldo **store credit** klienta
2. Wywołać **addStoreCreditsToCartWorkflow** dla koszyka subskrypcji
3. Obciążyć provider płatności tylko o pozostałą kwotę

#### Przykładowy flow

```typescript
// W workflow subskrypcji
async function processRecurringPayment(subscription) {
  // 1. Utwórz koszyk dla płatności cyklicznej
  const cart = await createCartForSubscription(subscription);

  // 2. Sprawdź dostępne saldo store credit
  const storeCreditAccount = await query.graph({
    entity: "store_credit_account",
    filters: {
      customer_id: subscription.customer_id,
      currency_code: cart.currency_code
    },
    fields: ["id", "balance"]
  });

  // 3. AUTOMATYCZNIE zastosuj store credit (ZAWSZE dla subskrypcji)
  if (storeCreditAccount && storeCreditAccount.balance > 0) {
    await addStoreCreditsToCartWorkflow.run({
      input: {
        cart_id: cart.id,
        // Brak 'amount' = użyj całego dostępnego salda
      }
    });
  }

  // 4. Kontynuuj standardowy checkout
  // (payment provider zostanie obciążony tylko o pozostałą kwotę)
  await completeCartWorkflow.run({
    input: { id: cart.id }
  });
}
```

#### Uwagi

- ✓ **Brak konfliktu** z pluginem loyalty
- ✓ Workflow **addStoreCreditsToCartWorkflow** jest wystarczający
- ⚠️ Wymaga **niestandardowej integracji** w pluginie subskrypcji
- ⚠️ Trzeba obsłużyć przypadek, gdy saldo jest **niewystarczające** (split payment)

---

## Macierz Zgodności Wymagań

| # | Wymaganie | Status | Bloker | Uwagi |
|---|-----------|--------|--------|-------|
| 1 | Rozróżnienie kart z indywidualnymi datami wygaśnięcia | ❌ | **TAK** | Konsolidacja sald — konflikt architektoniczny |
| 2 | Wykorzystanie FIFO | ❌ | **TAK** | Wymaga atomowości kart (patrz #1) |
| 3 | Admin: generowanie kart (kwota, waluta, data, ilość) | ⚠️ | NIE | Workflow istnieje, brak UI |
| 4 | Admin: eksport do CSV | ❌ | NIE | Do implementacji |
| 5 | Admin: system statusów (+ "przypisany") | ❌ | NIE | Tylko PENDING/REDEEMED, brak ASSIGNED |
| 6 | Admin: listing z filtrowaniem | ⚠️ | NIE | API istnieje, brak UI |
| 7 | Admin: deaktywowanie kart | ⚠️ | NIE | Tylko delete, nie zmiana statusu; problem po claiming |
| 8 | Proces: obniżenie kwoty (nie zniżka) | ✅ | NIE | W pełni poprawne zachowanie podatkowe |
| 9 | Proces: przypisywanie do konta | ⚠️ | NIE | Obsługiwane przez **claiming**, ale konsolidacja sald |
| 10 | Proces: opcjonalne wykorzystanie | ⚠️ | NIE | Opt-in, ale niejasna dokumentacja UI flow |
| 11 | Proces: auto-wykorzystanie dla subskrypcji | ❓ | NIE | Brak dokumentacji, wymaga integracji |

### Podsumowanie

- **Spełnienie wymagań:** 1/11 w pełni ✅, 5/11 częściowo ⚠️, 5/11 nie ❌
- **Blokery architektoniczne:** 2 wymagania (#1, #2)
- **Wymagania do implementacji:** 6 wymagań (#3-7, #11)

---

## Krytyczne Konflikty Architektoniczne

### Problem Konsolidacji Sald

Wymagania **#1** i **#2** są **niemożliwe do zrealizowania** z powodu fundamentalnej architektury pluginu:

```
┌──────────────────────────────────────────────────────────────┐
│ ARCHITEKTURA PLUGINU: Skonsolidowany Store Credit            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  GiftCard A (50 PLN, wygasa 31.12.2026) ──┐                 │
│  GiftCard B (30 PLN, wygasa 30.06.2027) ──┼──→ claiming     │
│  GiftCard C (20 PLN, wygasa 31.12.2027) ──┘                 │
│                                                              │
│                 ↓                                            │
│                                                              │
│  Konto Store Credit Klienta: 100 PLN                        │
│  (saldo zamienne, bez rozróżnienia źródeł)                  │
│                                                              │
│  ✗ Nie można śledzić indywidualnych kart                    │
│  ✗ Nie można wygasić części oddzielnie                      │
│  ✗ Nie można wymusić FIFO na skonsolidowanych środkach      │
└──────────────────────────────────────────────────────────────┘
```

vs.

```
┌──────────────────────────────────────────────────────────────┐
│ WASZE WYMAGANIA: Atomowe Śledzenie Kart                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  GiftCard A                                                  │
│  ├─ Saldo: 50 PLN                                           │
│  ├─ Wygasa: 31.12.2026                                      │
│  ├─ Status: przypisany                                      │
│  └─ Data przypisania: 01.06.2026                            │
│                                                              │
│  GiftCard B                                                  │
│  ├─ Saldo: 30 PLN                                           │
│  ├─ Wygasa: 30.06.2027                           KOLEJKA    │
│  ├─ Status: przypisany                             FIFO     │
│  └─ Data przypisania: 15.06.2026                    ↓       │
│                                                              │
│  GiftCard C                                                  │
│  ├─ Saldo: 20 PLN                                           │
│  ├─ Wygasa: 31.12.2027                                      │
│  ├─ Status: przypisany                                      │
│  └─ Data przypisania: 20.06.2026                            │
│                                                              │
│  ✓ Indywidualne salda śledzone                              │
│  ✓ Indywidualne wygaśnięcia wymuszane                       │
│  ✓ Kontrolowana kolejność FIFO                              │
└──────────────────────────────────────────────────────────────┘
```

**To są wzajemnie wykluczające się architektury.**

### Dlaczego konsolidacja istnieje

Plugin loyalty wykorzystuje model **store credit** jako wspólny mechanizm dla:
- Kart podarunkowych
- Kredytów lojalnościowych
- Zwrotów środków (refunds)
- Ręcznych korekt admina

**Store credit** jest projektowany jako:
- **Fungible balance** (zamienne saldo)
- **Ledger-based** (transakcje kredytowe/debetowe)
- **Unified per currency** (jedno konto na walutę)

To jest świadoma decyzja architektoniczna, nie błąd implementacji.

---

## Wnioski

### ✅ Zalety Pluginu

1. **Poprawne zachowanie podatkowe**
   - Credit lines nie wpływają na podstawę opodatkowania
   - Zgodne z wymogami compliance dla payment methods

2. **Solidny mechanizm transakcji**
   - Pełny audit trail z `reference` i `reference_id`
   - Kompensacja workflow przy błędach (automatic rollback)
   - Atomowe operacje na poziomie bazy danych

3. **Integracja z ekosystemem Medusa**
   - Wykorzystuje standardowe moduły (Cart, Order, Payment)
   - Hooks do core workflows
   - Spójny z workflow engine

4. **Multi-currency support**
   - Osobne konta store credit per waluta
   - Walidacja zgodności walut

### ❌ Główne Problemy

#### 1. Konsolidacja sald uniemożliwia atomowość

**Blokuje wymagania #1 i #2**

- Po przypisaniu (claiming) tracona jest tożsamość pojedynczych kart
- Niemożliwe wymuszenie indywidualnych dat wygaśnięcia
- Niemożliwa implementacja FIFO opartego na dacie przypisania karty

#### 2. Brak UI admina

**Dotyczy wymagań #3, #4, #6**

- Wszystkie funkcje administracyjne wymagają implementacji interfejsu
- Plugin dostarcza tylko API/workflow
- Dokumentacja nie precyzuje bulk operations w REST API

#### 3. Ograniczony system statusów

**Dotyczy wymagań #5, #7**

- Tylko dwa statusy: PENDING/REDEEMED
- Brak statusów: ASSIGNED, DEACTIVATED, EXPIRED, USED
- Brak mechanizmu statusowej dezaktywacji (tylko delete)

#### 4. Brak obsługi subskrypcji

**Dotyczy wymagania #11**

- Wymaga niestandardowej integracji w pluginie subskrypcji
- Brak automatycznego stosowania store credit dla recurring payments
- Brak dokumentacji best practices

#### 5. Terminologia myląca

**Dotyczy wymagania #9**

- "Redeeming" ≠ "wykorzystanie" w potocznym znaczeniu
- "Claiming" = przypisanie (nie jest intuicyjne)
- Wymaga dokładnej dokumentacji dla użytkowników końcowych

### 🔴 Krytyczne Blokery

**Wymagania #1 i #2** są **niemożliwe** do zrealizowania bez fundamentalnej przebudowy architektury pluginu:

1. **Trzeba by zastąpić** model store credit atomowym śledzeniem sald per gift card
2. **Trzeba by przepisać** całą logikę claiming i checkout
3. **Straciłoby się** integrację z refunds/credits/adjustments
4. **Efektywnie**: tworzy się nowy plugin, używając tylko nazw z loyalty

---

## Rekomendacja Końcowa

### Plugin MedusaJS Loyalty NIE NADAJE SIĘ do realizacji wymagań

**Powody:**

1. **Fundamentalny konflikt architektoniczny**
   - Konsolidacja vs. atomowość
   - Model fungible balance vs. FIFO tracking
   - Unified store credit vs. individual gift card lifecycle

2. **Wysokie koszty dostosowania**
   - Wymagania #3-7, #9-11 są technicznie możliwe do implementacji
   - Ale bez rozwiązania blokerów #1-2, system nie będzie działał zgodnie z wymaganiami biznesowymi
   - Ryzyko konfliktów przy aktualizacjach pluginu

3. **Brak gwarancji sukcesu**
   - Nawet z pełną custom implementacją, architektura store credit pozostaje w konflikcie
   - Model danych pluginu nie wspiera wymaganych funkcjonalności

### Rozważcie dedykowany moduł

Implementacja **własnego modułu kart podarunkowych**, który:

#### Model danych

```typescript
// Atomowe śledzenie sald bezpośrednio na gift card
model.define("GiftCard", {
  id: model.id({ prefix: "gc" }).primaryKey(),
  code: model.text().unique(),

  // Bezpośrednie saldo (bez pośrednictwa store credit)
  original_value: model.bigNumber(),
  current_balance: model.bigNumber(),

  // Przypisanie do klienta
  customer_id: model.text().nullable(),
  assigned_at: model.dateTime().nullable(),

  // Indywidualne wygaśnięcie
  expires_at: model.dateTime(),

  // Rozszerzony system statusów
  status: model.enum([
    "pending",
    "active",
    "assigned",      // ← Nowy
    "deactivated",   // ← Nowy
    "expired",       // ← Nowy
    "used"          // ← Nowy
  ]),

  // Audit
  metadata: model.json().nullable(),
});
```

#### Logika FIFO

```typescript
async function applyGiftCardsToOrder(customer_id, order_total) {
  // Pobierz eligible karty z sortowaniem FIFO
  const eligibleCards = await query({
    customer_id,
    status: "assigned",
    current_balance: { $gt: 0 },
    expires_at: { $gt: new Date() }
  })
  .sort({ assigned_at: "asc" });  // ← FIFO po dacie przypisania

  let remaining = order_total;
  const debits = [];

  for (const card of eligibleCards) {
    if (remaining <= 0) break;

    const amount = Math.min(card.current_balance, remaining);
    debits.push({
      gift_card_id: card.id,
      amount: amount
    });

    remaining -= amount;
  }

  return debits;
}
```

#### Integracja z checkout

```typescript
// Hook do completeCartWorkflow
async function beforePaymentAuthorization({ cart }) {
  if (!cart.customer_id) return;

  // Sprawdź opcję klienta
  if (cart.metadata?.use_gift_cards === false) return;

  // FIFO debit
  const debits = await applyGiftCardsToOrder(
    cart.customer_id,
    cart.total
  );

  // Utwórz credit lines
  for (const debit of debits) {
    await createCreditLine({
      cart_id: cart.id,
      amount: debit.amount,
      reference: "gift-card",
      reference_id: debit.gift_card_id
    });

    // Obciąż kartę
    await updateGiftCard(debit.gift_card_id, {
      current_balance: card.current_balance - debit.amount
    });
  }
}
```

### Korzyści własnego modułu

- ✅ **Pełna kontrola** nad logiką biznesową
- ✅ **Atomowe śledzenie** kart z indywidualnymi datami wygaśnięcia
- ✅ **FIFO ordering** zgodny z wymaganiami
- ✅ **Rozszerzony system statusów** (analogiczny do kodów aktywacyjnych)
- ✅ **Łatwa integracja** z pluginem subskrypcji
- ✅ **Brak ryzyka** konfliktów przy aktualizacjach MedusaJS

### Koszty własnego modułu

- Implementacja od podstaw (6-8 tygodni)
- Własne testy i dokumentacja
- Maintenance (ale bez ryzyka breaking changes z upstream)

**ROI: Pozytywny** — dedykowany moduł będzie łatwiejszy w utrzymaniu niż fork/extension loyalty plugin.

---

## Załączniki

### A. Glossary Terminów

| Termin | Znaczenie w pluginie loyalty |
|--------|------------------------------|
| **Gift Card** | Encja reprezentująca kartę podarunkową z kodem i metadanymi |
| **Store Credit** | Konto saldowe klienta, ledger-based (transakcje credit/debit) |
| **Redeeming** | Aktywacja gift card (utworzenie backing store credit account) |
| **Claiming** | Przypisanie gift card do klienta (transfer z anonymous do customer account) |
| **Credit Line** | Mechanizm stosowania gift cards/store credit do koszyka (tax-neutral) |
| **Workflow** | Orkiestrowana sekwencja kroków z możliwością kompensacji (rollback) |
| **Link** | Relacja między encjami z różnych modułów (przez Mikro-ORM) |

### B. Kluczowe Workflow

| Workflow | Cel | Input | Output |
|----------|-----|-------|--------|
| `createGiftCardsWorkflow` | Tworzenie kart podarunkowych | Tablica `ModuleCreateGiftCard` | Tablica `GiftCard` |
| `redeemGiftCardWorkflow` | Aktywacja karty (PENDING → REDEEMED) | `{ gift_card_id }` | `StoreCreditAccount` |
| `claimGiftCardWorkflow` | Przypisanie do klienta | `{ code, customer_id }` | void |
| `addGiftCardToCartWorkflow` | Dodanie do koszyka | `{ cart_id, code }` | `CreditLine[]` |
| `confirmCartCreditLinesWorkflow` | Obciążenie store credit przy checkout | `{ cart_id }` | void |
| `cloneCartGiftCardsToOrderWorkflow` | Linkowanie kart do zamówienia | `{ order_id, cart_id }` | void |

### C. Struktura Danych

#### GiftCard Model

```typescript
{
  id: string;              // Prefix: "gcard_"
  status: "pending" | "redeemed";
  value: BigNumber;
  code: string;            // Unique, searchable
  currency_code: string;   // ISO (e.g., "pln")
  expires_at: Date | null;
  reference_id: string | null;
  reference: string | null;
  line_item_id: string | null;
  note: string | null;
  metadata: object | null;
}
```

#### StoreCreditAccount Model

```typescript
{
  id: string;              // Prefix: "sca_"
  customer_id: string | null;  // null = anonymous
  currency_code: string;
  code: string;            // Unique identifier
  balance: BigNumber;      // Computed: sum(credits) - sum(debits)
  metadata: object | null;
}
```

#### AccountTransaction Model

```typescript
{
  id: string;
  account_id: string;
  type: "credit" | "debit";
  amount: BigNumber;
  reference: string;       // e.g., "gift_card", "cart", "order"
  reference_id: string;    // ID of referenced entity
  note: string | null;
  metadata: object | null;
  created_at: Date;
}
```

### D. Przykładowe Scenariusze

#### Scenariusz 1: Utworzenie i przypisanie karty

```
1. Admin tworzy gift card
   → createGiftCardsWorkflow
   → Status: REDEEMED, anonymous store credit account

2. Klient otrzymuje kod: GIFT-A3H7-9KLP-2XM4

3. Klient przypisuje kartę
   → claimGiftCardWorkflow
   → Saldo transferowane do konta klienta
   → Link: gift_card ↔ customer (przez store_credit_account)

4. Rezultat:
   - Gift card powiązany z klientem
   - Saldo w customer store credit account
   - ✗ Tracona atomowość (skonsolidowane z innymi kartami)
```

#### Scenariusz 2: Użycie w zamówieniu

```
1. Klient dodaje produkty do koszyka
   → Cart total: 200 PLN

2. Klient ma store credit: 50 PLN (z trzech różnych gift cards)

3. Klient decyduje się użyć salda
   → addStoreCreditsToCartWorkflow
   → Credit line: 50 PLN

4. Checkout:
   → confirmCartCreditLinesWorkflow
   → Debit store credit account: -50 PLN
   → Payment provider (Stripe): 150 PLN

5. Rezultat:
   - Store credit obciążony: 50 PLN
   - Klient płaci: 150 PLN
   - ✗ Nie wiadomo, które gift cards zostały wykorzystane (FIFO nie działa)
```

#### Scenariusz 3: Fraud detection po przypisaniu

```
1. Klient kupuje gift card za 100 PLN (fraudulent payment)
   → createGiftCardsWorkflow
   → Gift card utworzony, REDEEMED

2. Klient przypisuje kartę
   → claimGiftCardWorkflow
   → 100 PLN w customer store credit account

3. Bank wykrywa fraud, merchant musi cofnąć

4. Admin próbuje deaktywować:
   → deleteGiftCardWorkflow
   → ✗ Rekord gift_card usunięty
   → ✗ Ale 100 PLN pozostaje w store credit account
   → ✗ Klient może wydać środki

5. Problem:
   - Brak mechanizmu "wycofania" kredytu ze skonsolidowanego salda
   - Trzeba ręcznie utworzyć debit transaction
```

---

**Koniec dokumentu**
